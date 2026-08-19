variable "aws_region" {
  description = "AWS region for the backup bucket."
  type        = string
  default     = "eu-central-1"
}

variable "bucket_name" {
  description = "Globally unique S3 bucket name for backups."
  type        = string
}

variable "backup_prefix" {
  description = "Key prefix under which CSV backups are written. Must match AWS_S3_PREFIX in .env."
  type        = string
  default     = "backups"
}

variable "iam_user_name" {
  description = "IAM user the backup script authenticates as."
  type        = string
  default     = "money-tracker-backup"
}
