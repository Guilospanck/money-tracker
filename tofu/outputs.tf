output "bucket_name" {
  value = aws_s3_bucket.backups.id
}

output "bucket_arn" {
  value = aws_s3_bucket.backups.arn
}

output "iam_user_arn" {
  value = aws_iam_user.backup.arn
}

output "aws_access_key_id" {
  value     = aws_iam_access_key.backup.id
  sensitive = true
}

output "aws_secret_access_key" {
  value     = aws_iam_access_key.backup.secret
  sensitive = true
}

# Copy-paste helper. The secret is marked sensitive above, so it does not
# appear here — print it once with `tofu output -raw aws_secret_access_key`.
output "env_file_snippet" {
  description = "Paste into .env, then fill AWS_SECRET_ACCESS_KEY from `tofu output -raw aws_secret_access_key`."
  value       = <<-EOT
    AWS_ACCESS_KEY_ID=${aws_iam_access_key.backup.id}
    AWS_SECRET_ACCESS_KEY=<run: tofu output -raw aws_secret_access_key>
    AWS_REGION=${var.aws_region}
    AWS_S3_BUCKET=${aws_s3_bucket.backups.id}
    AWS_S3_PREFIX=${var.backup_prefix}
  EOT
}
