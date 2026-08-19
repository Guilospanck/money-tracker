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
    AWS_PROFILE=money-tracker tofu -chdir=tofu init

# Check that all .tf files are canonically formatted
tofu-fmt:
    AWS_PROFILE=money-tracker tofu -chdir=tofu fmt -check -recursive

# Validate HCL syntax and provider schema (no AWS API calls)
tofu-validate:
    AWS_PROFILE=money-tracker tofu -chdir=tofu validate

# Show the diff between desired and actual AWS state
tofu-plan:
    AWS_PROFILE=money-tracker tofu -chdir=tofu plan

# Apply the IaC (creates / updates the S3 bucket, IAM user, access key)
tofu-apply:
    AWS_PROFILE=money-tracker tofu -chdir=tofu apply

# Print the .env snippet (everything except the secret)
tofu-print-env:
    AWS_PROFILE=money-tracker tofu -chdir=tofu output env_file_snippet

# Print the backup user's AWS_SECRET_ACCESS_KEY (raw, no quotes)
tofu-print-secret:
    AWS_PROFILE=money-tracker tofu -chdir=tofu output -raw aws_secret_access_key

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
