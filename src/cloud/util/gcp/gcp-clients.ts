/**
 * gcp-clients — shared @google-cloud/compute client instances.
 */
import { InstancesClient, ProjectsClient, ZoneOperationsClient } from "@google-cloud/compute";

export const instancesClient = new InstancesClient();
export const zoneOperationsClient = new ZoneOperationsClient();
export const projectsClient = new ProjectsClient();
