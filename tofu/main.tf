provider "aws" {
  region = var.aws_region
}

# ---- S3 bucket ------------------------------------------------------------

# resource TYPE LOCAL_NAME { ... }
# You can't invent types. They come from providers. Here, aws_s3_bucket is a resource type defined by the AWS provider.
resource "aws_s3_bucket" "backups" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---- IAM user with write-only-CSV policy ---------------------------------

resource "aws_iam_user" "backup" {
  name = var.iam_user_name
}

data "aws_iam_policy_document" "backup_upload" {
  statement {
    sid     = "AllowDailyCsvBackupOnly"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.backups.arn}/${var.backup_prefix}/money-tracker-*.csv",
    ]
  }
}

resource "aws_iam_user_policy" "backup_upload" {
  name   = "money-tracker-backup-upload"
  user   = aws_iam_user.backup.name
  policy = data.aws_iam_policy_document.backup_upload.json
}

resource "aws_iam_access_key" "backup" {
  user = aws_iam_user.backup.name
}
