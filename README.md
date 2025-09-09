Used in CS 160 autograders. May be vestigial -- there's probably a better solution to the problem this is trying to solve, given I've switched this to being cloud-native.

Upload keys permit a client to upload arbitrary files to S3, to be hosted by Cloudfront; these make their way into the Docker image, so there's some reliance here on security-through-obscurity.


To set up the upload server:

- make an AWS account! add billing. this shouldn't cost much to host (probably a few dollars for a typical semester of use), but this is of course dependent on usage.
- make a hosted zone manually in Route 53 for a (sub)domain. use NS records if the domain is hosted elsewhere. this is needed so we can set up wildcards/certs; each upload gets its own origin to keep things isolated.
  - need the hosted zone id, it's a bunch of numbers and uppercase letters
- copy terraform.tfvars.example to terraform.tfvars
  - and set values:
    - base_domain is your subdomain you're using here
    - project_name is arbitrary, helps identify resources in AWS dashboard
    - max_content_length_mb can be 100, sure
    - region I use "us-west-2" which is in oregon
    - route53_zone_id from above
    - upload_key is any long secret string you generate. it is used by the autograder image when uploading
- install node/npm. `cd lambda && npm install` (so the lambda zip has the right dependencies)
- install opentofu (open-source terraform alternative; this is what sets up the cloud infrastructure). `cd tf && tofu init && tofu apply`


`tofu apply` takes a few minutes to set up the endpooint, the first time. It'll show you outputs in the CLI; in particular you want `api_url`, which is going to be `UPLOAD_SERVER` in autograder-config.sh. UPLOAD_SERVER_KEY is your secret string (the `upload_key` variable).
