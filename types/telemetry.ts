export type RemoteType = 'ANYDESK' | 'RUDESKTOP' | 'NONE';

export interface RemoteAccess {
  type: RemoteType;
  id: string;
}

export interface RuntimeErrorItem {
  time: string;
  event: string;
  error_text: string;
}

export type HealthCheckStatus = 'OK' | 'WARN' | 'ERROR';

export interface HealthCheckItem {
  id: string;
  name?: string;
  status: HealthCheckStatus;
  details: string;
}

export interface TelemetryPayload {
  shop: string;
  workplace: string;
  remote: RemoteAccess;
  warnings?: string[];
  runtime_errors?: RuntimeErrorItem[];
  system_info?: Record<string, unknown> | null;
  health_checks?: HealthCheckItem[];
}

export type IncidentStatus = 'ACTIVE' | 'RESOLVED';
export type IncidentSeverity = 'ERROR' | 'WARN' | 'INFO';

export interface Workplace {
  id: string;
  shop_name: string;
  workplace_name: string;
  remote_type: RemoteType;
  remote_id: string | null;
  system_info_json?: string | null;
  last_seen: string;
}

export interface Incident {
  id: number;
  workplace_id: string;
  error_hash: string;
  error_type: string;
  severity?: IncidentSeverity;
  raw_error: string;
  ai_diagnosis: string | null;
  ai_actions: string | null;
  occurrences_count: number;
  status: IncidentStatus;
  created_at: string;
  last_occurred_at: string;
}

export interface TelemetryResponse {
  success: boolean;
  workplace_id: string;
  incidents_recorded: number;
  config: {
    next_check_seconds: number;
    ota_enabled: boolean;
  };
}
