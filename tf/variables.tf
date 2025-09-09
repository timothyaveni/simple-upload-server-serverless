variable "project_name" { type = string }
variable "base_domain"  { type = string } # e.g., "autograder-artifacts-sp25.160.tja.io"
variable "route53_zone_id" {
  type        = string
  description = "Existing hosted zone ID that contains base_domain."
}
variable "upload_key" {
  type      = string
  sensitive = true
}
variable "max_content_length_mb" {
  type    = number
  default = 100
}
variable "region" {
  type    = string
  default = "us-west-2"
}
