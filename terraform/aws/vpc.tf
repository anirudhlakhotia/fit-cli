# A VPC dedicated to fit-cli. Its main purpose today is isolating Capella Private
# Endpoint testing from sdkqe-github-runners-tf's cbqerunners-vpc: fit-cli's
# instances used to share that VPC, so infra changes made for the GHA
# self-hosted runners (AMI rebuilds, SG/route table edits) could silently
# affect PE connectivity. A dedicated VPC removes that shared blast radius.

locals {
  fit_cli_vpc_cidr    = "10.50.0.0/16"
  fit_cli_subnet_cidr = "10.50.1.0/24"
  fit_cli_az          = "us-west-2b"
}

resource "aws_vpc" "fit_cli" {
  cidr_block           = local.fit_cli_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "fit-cli-vpc"
  }
}

resource "aws_internet_gateway" "fit_cli" {
  vpc_id = aws_vpc.fit_cli.id

  tags = {
    Name = "fit-cli-igw"
  }
}

# Public so launched instances get a public IP - avoids the cost/complexity of a NAT Gateway for outbound-only
# traffic like docker pulls and apt).
resource "aws_subnet" "fit_cli_public" {
  vpc_id                  = aws_vpc.fit_cli.id
  cidr_block              = local.fit_cli_subnet_cidr
  availability_zone       = local.fit_cli_az
  map_public_ip_on_launch = true

  tags = {
    Name = "fit-cli-public"
  }
}

resource "aws_route_table" "fit_cli_public" {
  vpc_id = aws_vpc.fit_cli.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.fit_cli.id
  }

  tags = {
    Name = "fit-cli-public-rt"
  }
}

resource "aws_route_table_association" "fit_cli_public" {
  subnet_id      = aws_subnet.fit_cli_public.id
  route_table_id = aws_route_table.fit_cli_public.id
}

# Adopts (does not create) the default security group AWS gives every VPC, and declares the
# rules it ships with. cbdinocluster's `private-endpoints setup-link` creates a Capella
# PrivateLink endpoint that lands in this SG (no explicit SG is passed to AWS's
# CreateVpcEndpoint, so it defaults to the VPC's default SG), so instances doing private
# endpoint testing need to be in it too to reach the cluster (see privateEndpointVpcSgId
# in environments.json5).
resource "aws_default_security_group" "fit_cli" {
  vpc_id = aws_vpc.fit_cli.id

  ingress {
    description = "All traffic between members of this security group"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "fit-cli-default"
  }
}
