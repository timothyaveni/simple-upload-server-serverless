output "upload_endpoint" {
  value = "${aws_apigatewayv2_api.http.api_endpoint}/upload"
}
output "public_hostname_pattern" {
  value = "*.${var.base_domain}"
}
