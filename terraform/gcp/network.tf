locals {
  fit_cli_gcp_apis = [
    "compute.googleapis.com",
    "dns.googleapis.com",
    "iap.googleapis.com",
    "oslogin.googleapis.com",
  ]
}

resource "google_project_service" "fit_cli" {
  for_each = toset(local.fit_cli_gcp_apis)
  project  = var.gcp_project_id
  service  = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "fit_cli" {
  name                    = "fit-cli-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.fit_cli]
}

resource "google_compute_subnetwork" "fit_cli_us_west1" {
  name          = "fit-cli-us-west1"
  # Arbitrary private RFC1918 block
  ip_cidr_range = "10.60.1.0/24"
  region        = "us-west1"
  network       = google_compute_network.fit_cli.id
  private_ip_google_access = true
}

# Allow general outbound traffic for apt, curl, docker pull etc.
resource "google_compute_router" "fit_cli_us_west1" {
  name    = "fit-cli-us-west1-router"
  region  = "us-west1"
  network = google_compute_network.fit_cli.id
}

resource "google_compute_router_nat" "fit_cli_us_west1" {
  name                               = "fit-cli-us-west1-nat"
  router                             = google_compute_router.fit_cli_us_west1.name
  region                             = "us-west1"
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# Enables OS Login project-wide, so `gcloud compute ssh --tunnel-through-iap` works.
resource "google_compute_project_metadata_item" "enable_oslogin" {
  project = var.gcp_project_id
  key     = "enable-oslogin"
  value   = "TRUE"

  depends_on = [google_project_service.fit_cli]
}
