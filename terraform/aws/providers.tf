provider "aws" {
  region = "us-west-2"

  default_tags {
    tags = {
      Environment = "fit-cli"
    }
  }
}

data "aws_caller_identity" "current" {}
