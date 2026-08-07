# us-west1 is not arbitrary: it's cbdinocluster's DEFAULT_GCP_REGION, and the box
# and the Capella cluster must share a region for Private Service Connect to
# reach it.
provider "google" {
  project = var.gcp_project_id
  region  = "us-west1"
}
