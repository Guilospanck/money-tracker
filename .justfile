# Money Tracker

# Start the app server
serve:
    npm start

# Stop the running server
stop:
    pkill -f "node server.js" && echo "Stopped" || echo "Not running"

# Scrape transactions from MinhasEconomias and generate transactions.csv
scrape:
    npm run scrape

# Install dependencies
install:
    npm install

# Initialize OpenTofu (downloads providers, writes lock file)
tofu-init:
    tofu -chdir=tofu init

# Check that all .tf files are canonically formatted
tofu-fmt:
    tofu -chdir=tofu fmt -check -recursive

# Validate HCL syntax and provider schema (no AWS API calls)
tofu-validate:
    tofu -chdir=tofu validate

# Show the diff between desired and actual AWS state
tofu-plan:
    just _with iac env AWS_PROFILE=money-tracker tofu -chdir=tofu plan

# Apply the IaC (creates / updates the S3 bucket, IAM user, access key)
tofu-apply:
    just _with iac env AWS_PROFILE=money-tracker tofu -chdir=tofu apply

# Print the .env snippet (everything except the secret)
tofu-print-env:
    tofu -chdir=tofu output env_file_snippet

# Print the backup user's AWS_SECRET_ACCESS_KEY (raw, no quotes)
tofu-print-secret:
    tofu -chdir=tofu output -raw aws_secret_access_key

# ---- Temporary IAM user for OpenTofu (root only signs in to make/remove it) ----
# Flow: just aws-root-login; just aws-iac-create; (tofu-plan / tofu-apply);
#       just aws-iac-delete; just aws-root-logout. Policy: tofu/iac-policy.json.

iac_user := "money-tracker-iac"
root_profile := "root-tmp"

# Run a command with a temporary AWS user, and clean up after. If the profile already exists
# (you are inside `just iac ...`), the command just runs. Otherwise: root login (browser),
# create the user, run, then delete the user, its profile, and log out of root, even on error.
[positional-arguments]
_with kind *cmd:
    #!/usr/bin/env bash
    set -uo pipefail
    kind="$1"; shift
    case "$kind" in
        iac) prof=money-tracker; mk=aws-iac-create; rm=aws-iac-delete;;
        *) echo "unknown kind $kind" >&2; exit 1;;
    esac
    if aws configure list-profiles 2>/dev/null | grep -qx "$prof"; then exec "$@"; fi
    root={{root_profile}}
    is_root() { aws sts get-caller-identity --profile "$root" --query Arn --output text 2>/dev/null | grep -q ':root$'; }
    cleanup() {
        trap - EXIT INT TERM
        echo ">> cleaning up the temporary AWS user" >&2
        just "$rm" || true
        just aws-root-logout || true
    }
    is_root || just aws-root-login || exit 1
    trap cleanup EXIT
    trap 'exit 130' INT TERM
    just "$mk" || exit 1
    sleep 12
    "$@"
    rc=$?
    exit $rc

# Run recipes with a temporary OpenTofu AWS user, then clean up: `just iac tofu-plan tofu-apply`.
iac +recipes:
    just _with iac just {{recipes}}

# Remove an AWS profile's sections from ~/.aws/credentials and ~/.aws/config.
_aws-forget profile:
    #!/usr/bin/env bash
    set -euo pipefail
    for f in ~/.aws/credentials ~/.aws/config; do
        [ -f "$f" ] || continue
        t="$(mktemp)"
        awk -v a="[{{profile}}]" -v b="[profile {{profile}}]" '/^\[/{skip=($0==a||$0==b)} !skip' "$f" > "$t"
        cat "$t" > "$f"; rm -f "$t"
    done

# Sign in as the AWS root user (opens a browser) under the temporary profile root-tmp.
aws-root-login:
    aws login --profile {{root_profile}}
    aws sts get-caller-identity --profile {{root_profile}}

# Create the OpenTofu IAM user, give it tofu/iac-policy.json, store its key as the AWS profile "money-tracker".
aws-iac-create:
    #!/usr/bin/env bash
    set -euo pipefail
    p={{root_profile}}
    arn="$(aws sts get-caller-identity --profile "$p" --query Arn --output text)"
    case "$arn" in *:root) ;; *) echo "profile $p is not root ($arn): run just aws-root-login" >&2; exit 1;; esac
    account="$(aws sts get-caller-identity --profile "$p" --query Account --output text)"
    pol="arn:aws:iam::$account:policy/{{iac_user}}"
    if aws iam get-user --profile "$p" --user-name {{iac_user}} >/dev/null 2>&1 \
        || aws iam get-policy --profile "$p" --policy-arn "$pol" >/dev/null 2>&1; then
        echo "user {{iac_user}} or its policy already exists: run just aws-iac-delete first" >&2; exit 1
    fi
    aws iam create-user --profile "$p" --user-name {{iac_user}} >/dev/null
    doc="$(mktemp)"; trap 'rm -f "$doc"' EXIT
    sed "s/__ACCOUNT__/$account/g" tofu/iac-policy.json > "$doc"
    aws iam create-policy --profile "$p" --policy-name {{iac_user}} --policy-document "file://$doc" >/dev/null
    aws iam attach-user-policy --profile "$p" --user-name {{iac_user}} --policy-arn "$pol"
    read -r id secret < <(aws iam create-access-key --profile "$p" --user-name {{iac_user}} \
        --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
    aws configure set aws_access_key_id "$id" --profile money-tracker
    aws configure set aws_secret_access_key "$secret" --profile money-tracker
    echo "created {{iac_user}}; its key is in profile money-tracker. IAM can take ~10 s to propagate."

# Delete the OpenTofu IAM user (keys, policies, user). Needs root-tmp.
aws-iac-delete:
    #!/usr/bin/env bash
    set -euo pipefail
    p={{root_profile}}
    arn="$(aws sts get-caller-identity --profile "$p" --query Arn --output text)"
    case "$arn" in *:root) ;; *) echo "profile $p is not root ($arn): run just aws-root-login" >&2; exit 1;; esac
    for k in $(aws iam list-access-keys --profile "$p" --user-name {{iac_user}} --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null); do
        aws iam delete-access-key --profile "$p" --user-name {{iac_user}} --access-key-id "$k"
    done
    account="$(aws sts get-caller-identity --profile "$p" --query Account --output text)"
    pol="arn:aws:iam::$account:policy/{{iac_user}}"
    aws iam detach-user-policy --profile "$p" --user-name {{iac_user}} --policy-arn "$pol" 2>/dev/null || true
    aws iam delete-policy --profile "$p" --policy-arn "$pol" 2>/dev/null || true
    aws iam delete-user --profile "$p" --user-name {{iac_user}}
    just _aws-forget money-tracker
    echo "deleted {{iac_user}} and removed profile money-tracker from ~/.aws."

# Sign out of the temporary root profile.
aws-root-logout:
    aws logout --profile {{root_profile}}
    just _aws-forget {{root_profile}}

# The `deploy` recipe and friends expect an SSH alias `money-tracker` in ~/.ssh/config.
# Replace the placeholders below (<server-ip>, youruser, key path) with your own values:
#
#   Host money-tracker
#       HostName <server-ip>
#       User youruser
#       IdentityFile ~/.ssh/id_ed25519

# Rsync the working tree to the `money-tracker` SSH alias (excludes node_modules and local-only state; .env IS included)
# WARNING: this pushes your real .env (credentials + AWS keys) to the server. Intended, but be aware.
deploy:
    rsync -av --delete \
        --exclude='node_modules/' \
        --exclude='.git/' \
        --exclude='.claude/' \
        --exclude='data.sqlite*' \
        --exclude='transactions.csv' \
        --exclude='backup.log' \
        --exclude='tofu/.terraform/' \
        --exclude='tofu/*.tfstate*' \
        --exclude='tofu/terraform.tfvars' \
        ./ money-tracker:~/money-tracker/

# (Run on the Linux server) Copy unit files into /etc/systemd/system/ and reload systemd.
# FIRST edit the unit files: replace the `youruser` / /home/youruser placeholders and the
# ExecStart `node` path with your real values. See the NOTE header in each systemd/*.service.
systemd-install:
    sudo cp systemd/money-tracker.service systemd/money-tracker-backup.service systemd/money-tracker-backup.timer /etc/systemd/system/
    sudo systemctl daemon-reload

# (Run on the Linux server) Enable + start the app service and the backup timer.
systemd-enable:
    sudo systemctl enable --now money-tracker.service
    sudo systemctl enable --now money-tracker-backup.timer

# (Run on the Linux server) Show status of both units.
systemd-status:
    systemctl status money-tracker.service --no-pager
    systemctl status money-tracker-backup.timer --no-pager
