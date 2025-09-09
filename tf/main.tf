terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.50"
    }
    archive = {
      source = "hashicorp/archive"
      version = ">= 2.5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# ACM must be in us-east-1 for CloudFront
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

locals {
  lambda_name   = "${var.project_name}-uploader"
  bucket_name   = "${var.project_name}-uploads-${random_id.suffix.hex}"
  cf_name       = "${var.project_name}-cdn"
  wildcard_host = "*.${var.base_domain}"
}

resource "random_id" "suffix" {
  byte_length = 4
}

# S3 bucket for extracted files
resource "aws_s3_bucket" "uploads" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id   # <-- was wrong before
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront Origin Access Control (modern OAC)
resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "${var.project_name}-oac"
  description                       = "OAC for ${aws_s3_bucket.uploads.bucket}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Bucket policy allowing CloudFront to read
data "aws_caller_identity" "me" {}

# We will reference the distribution ID later; for now create the policy dynamically
data "aws_iam_policy_document" "s3_oac_policy" {
  statement {
    sid    = "AllowCloudFrontServicePrincipal"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.cdn.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  policy = data.aws_iam_policy_document.s3_oac_policy.json
  depends_on = [aws_cloudfront_distribution.cdn]
}

# ACM certificate for wildcard
resource "aws_acm_certificate" "wildcard" {
  provider          = aws.us_east_1
  domain_name       = local.wildcard_host
  validation_method = "DNS"

  subject_alternative_names = [] # you can add var.base_domain if you also want apex
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }
  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.value]
}

resource "aws_acm_certificate_validation" "wildcard" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.wildcard.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# CloudFront Function for host->prefix rewrite
resource "aws_cloudfront_function" "host_to_prefix" {
  name    = "${var.project_name}-host-rewrite"
  runtime = "cloudfront-js-1.0"
  code    = file("${path.module}/../cloudfront-function.js")
  publish = true
}

# CloudFront distribution
resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  comment             = local.cf_name
  is_ipv6_enabled     = true
  default_root_object = "index.html"

  aliases = [local.wildcard_host]

  origin {
    origin_id                = "s3-origin"
    domain_name              = aws_s3_bucket.uploads.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.host_to_prefix.arn
    }

    # If you prefer modern policies, replace forwarded_values with:
    # cache_policy_id          = data.aws_cloudfront_cache_policy.CachingOptimized.id
    # origin_request_policy_id = data.aws_cloudfront_origin_request_policy.AllViewer.id
    forwarded_values {
      query_string = true
      cookies { forward = "none" }
    }
  }

  price_class = "PriceClass_100"

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.wildcard.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  depends_on = [aws_acm_certificate_validation.wildcard]
}

# API Gateway (HTTP API) + Lambda

# Package lambda from ./lambda directory
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/build/lambda.zip"
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${var.project_name}-lambda-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow",
      Principal = { Service = "lambda.amazonaws.com" },
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "lambda_s3_put" {
  name   = "${var.project_name}-lambda-s3-put"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect   = "Allow",
      Action   = [
        "s3:PutObject",
        "s3:CreateMultipartUpload",
        "s3:UploadPart",
        "s3:CompleteMultipartUpload",
        "s3:AbortMultipartUpload"
      ],
      Resource = ["${aws_s3_bucket.uploads.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_s3_put_attach" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_s3_put.arn
}

resource "aws_lambda_function" "uploader" {
  function_name    = local.lambda_name
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.lambda_zip.output_path
  memory_size      = 512
  timeout          = 30
  publish          = true
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      UPLOAD_KEY              = var.upload_key
      BASE_DOMAIN             = var.base_domain
      BUCKET_NAME             = aws_s3_bucket.uploads.bucket
      MAX_CONTENT_LENGTH_MB   = var.max_content_length_mb
    }
  }
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.project_name}-http"
  protocol_type = "HTTP"
  # Binary media types to ensure multipart reaches Lambda base64-encoded
  # (HTTP API uses 'binaryMediaTypes' only on old REST; for HTTP API,
  # Lambda receives isBase64Encoded automatically when content-type isn't text/JSON)
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.uploader.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "upload" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /upload"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.uploader.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}

# Route53 wildcard -> CloudFront
resource "aws_route53_record" "wildcard_alias" {
  zone_id = var.route53_zone_id
  name    = "*.${var.base_domain}"
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.cdn.domain_name
    zone_id                = aws_cloudfront_distribution.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}

output "api_url" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "wildcard_host" {
  value = "*.${var.base_domain}"
}

output "bucket" {
  value = aws_s3_bucket.uploads.bucket
}
