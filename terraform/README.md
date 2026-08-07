AWS and GCP static infra for fit-cli are under Terraform control.

```
terraform -chdir=terraform/aws plan
terraform -chdir=terraform/aws apply

terraform -chdir=terraform/gcp plan
terraform -chdir=terraform/gcp apply
```