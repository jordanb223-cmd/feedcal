
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "attachment_pages": {
                  Row: {
                    "attachment_id": string,"created_at": string,"image_path": string | null,"page_index": number,"text": string | null,"text_source": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attachment_id": string,"created_at"?: string,"image_path"?: string | null,"page_index": number,"text"?: string | null,"text_source": string
                  }
                  Update: {
                    "attachment_id"?: string,"created_at"?: string,"image_path"?: string | null,"page_index"?: number,"text"?: string | null,"text_source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attachment_pages_attachment_id_fkey"
      columns: ["attachment_id"]
isOneToOne: false
      referencedRelation: "attachments"
      referencedColumns: ["id"]
    }
                  ]
                },"attachments": {
                  Row: {
                    "bytes": number | null,"chosen": boolean,"content_id": string | null,"created_at": string,"filename": string | null,"height": number | null,"id": string,"inline": boolean,"message_id": string,"mime": string | null,"pages": number | null,"sha256": string | null,"status": string,"storage_path": string | null,"triage": Json | null,"triaged_at": string | null,"width": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "bytes"?: number | null,"chosen"?: boolean,"content_id"?: string | null,"created_at"?: string,"filename"?: string | null,"height"?: number | null,"id"?: string,"inline"?: boolean,"message_id": string,"mime"?: string | null,"pages"?: number | null,"sha256"?: string | null,"status"?: string,"storage_path"?: string | null,"triage"?: Json | null,"triaged_at"?: string | null,"width"?: number | null
                  }
                  Update: {
                    "bytes"?: number | null,"chosen"?: boolean,"content_id"?: string | null,"created_at"?: string,"filename"?: string | null,"height"?: number | null,"id"?: string,"inline"?: boolean,"message_id"?: string,"mime"?: string | null,"pages"?: number | null,"sha256"?: string | null,"status"?: string,"storage_path"?: string | null,"triage"?: Json | null,"triaged_at"?: string | null,"width"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "attachments_message_id_fkey"
      columns: ["message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"event_candidates": {
                  Row: {
                    "all_day": boolean,"attachment_id": string | null,"change_kind": string,"confidence": number,"created_at": string,"decided_at": string | null,"description": string | null,"ends_at": string | null,"event_id": string | null,"evidence_quote": string,"feed_id": string,"from_transcription": boolean,"id": string,"location": string | null,"match_score": number | null,"message_id": string,"model": string | null,"outcome": string | null,"page_index": number | null,"review_reasons": (string)[],"rrule": string | null,"source_kind": string,"starts_at": string,"state": string,"timezone": string,"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "all_day": boolean,"attachment_id"?: string | null,"change_kind": string,"confidence": number,"created_at"?: string,"decided_at"?: string | null,"description"?: string | null,"ends_at"?: string | null,"event_id"?: string | null,"evidence_quote": string,"feed_id": string,"from_transcription"?: boolean,"id"?: string,"location"?: string | null,"match_score"?: number | null,"message_id": string,"model"?: string | null,"outcome"?: string | null,"page_index"?: number | null,"review_reasons"?: (string)[],"rrule"?: string | null,"source_kind": string,"starts_at": string,"state"?: string,"timezone": string,"title": string
                  }
                  Update: {
                    "all_day"?: boolean,"attachment_id"?: string | null,"change_kind"?: string,"confidence"?: number,"created_at"?: string,"decided_at"?: string | null,"description"?: string | null,"ends_at"?: string | null,"event_id"?: string | null,"evidence_quote"?: string,"feed_id"?: string,"from_transcription"?: boolean,"id"?: string,"location"?: string | null,"match_score"?: number | null,"message_id"?: string,"model"?: string | null,"outcome"?: string | null,"page_index"?: number | null,"review_reasons"?: (string)[],"rrule"?: string | null,"source_kind"?: string,"starts_at"?: string,"state"?: string,"timezone"?: string,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_candidates_attachment_id_fkey"
      columns: ["attachment_id"]
isOneToOne: false
      referencedRelation: "attachments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "event_candidates_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "event_candidates_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "event_candidates_message_id_fkey"
      columns: ["message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"event_revisions": {
                  Row: {
                    "actor": string,"cause": string,"created_at": string,"diff": NonNullable<Json>,"event_id": string,"id": number,"sequence": number
                  }
                  ComputedFields: never
                  Insert: {
                    "actor": string,"cause": string,"created_at"?: string,"diff": NonNullable<Json>,"event_id": string,"id"?: never,"sequence": number
                  }
                  Update: {
                    "actor"?: string,"cause"?: string,"created_at"?: string,"diff"?: NonNullable<Json>,"event_id"?: string,"id"?: never,"sequence"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_revisions_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    }
                  ]
                },"events": {
                  Row: {
                    "all_day": boolean,"confidence": number | null,"created_at": string,"description": string | null,"ends_at": string | null,"evidence_quote": string | null,"exdates": (string)[],"feed_id": string,"id": string,"location": string | null,"published": boolean,"rrule": string | null,"sequence": number,"source_message_id": string | null,"source_thread": string | null,"starts_at": string,"status": string,"timezone": string,"title": string,"uid": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "all_day"?: boolean,"confidence"?: number | null,"created_at"?: string,"description"?: string | null,"ends_at"?: string | null,"evidence_quote"?: string | null,"exdates"?: (string)[],"feed_id": string,"id"?: string,"location"?: string | null,"published"?: boolean,"rrule"?: string | null,"sequence"?: number,"source_message_id"?: string | null,"source_thread"?: string | null,"starts_at": string,"status"?: string,"timezone"?: string,"title": string,"uid"?: never,"updated_at"?: string
                  }
                  Update: {
                    "all_day"?: boolean,"confidence"?: number | null,"created_at"?: string,"description"?: string | null,"ends_at"?: string | null,"evidence_quote"?: string | null,"exdates"?: (string)[],"feed_id"?: string,"id"?: string,"location"?: string | null,"published"?: boolean,"rrule"?: string | null,"sequence"?: number,"source_message_id"?: string | null,"source_thread"?: string | null,"starts_at"?: string,"status"?: string,"timezone"?: string,"title"?: string,"uid"?: never,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "events_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "events_source_message_id_fkey"
      columns: ["source_message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"feed_editors": {
                  Row: {
                    "created_at": string,"feed_id": string,"role": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"feed_id": string,"role": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"feed_id"?: string,"role"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "feed_editors_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "feed_editors_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"feed_fetch_daily": {
                  Row: {
                    "client_hash": string,"day": string,"feed_id": string,"user_agent_family": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "client_hash": string,"day": string,"feed_id": string,"user_agent_family"?: string | null
                  }
                  Update: {
                    "client_hash"?: string,"day"?: string,"feed_id"?: string,"user_agent_family"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "feed_fetch_daily_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    }
                  ]
                },"feeds": {
                  Row: {
                    "auto_publish_threshold": number | null,"category": string | null,"created_at": string,"description": string | null,"feed_token_hash": string,"feed_token_secret_id": string,"id": string,"intake_address": string,"last_updated_at": string,"location": unknown,"name": string,"owner_id": string,"search": unknown,"slug": string,"timezone": string,"visibility": string,"zip_code": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "auto_publish_threshold"?: number | null,"category"?: string | null,"created_at"?: string,"description"?: string | null,"feed_token_hash": string,"feed_token_secret_id": string,"id"?: string,"intake_address": string,"last_updated_at"?: string,"location"?: unknown,"name": string,"owner_id"?: string,"search"?: never,"slug": string,"timezone"?: string,"visibility"?: string,"zip_code"?: string | null
                  }
                  Update: {
                    "auto_publish_threshold"?: number | null,"category"?: string | null,"created_at"?: string,"description"?: string | null,"feed_token_hash"?: string,"feed_token_secret_id"?: string,"id"?: string,"intake_address"?: string,"last_updated_at"?: string,"location"?: unknown,"name"?: string,"owner_id"?: string,"search"?: never,"slug"?: string,"timezone"?: string,"visibility"?: string,"zip_code"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "feeds_owner_id_fkey"
      columns: ["owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"forwarding_confirmations": {
                  Row: {
                    "code": string,"confirm_url": string | null,"expires_at": string,"feed_id": string,"id": string,"provider": string,"received_at": string,"requested_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"confirm_url"?: string | null,"expires_at": string,"feed_id": string,"id"?: string,"provider": string,"received_at"?: string,"requested_by"?: string | null
                  }
                  Update: {
                    "code"?: string,"confirm_url"?: string | null,"expires_at"?: string,"feed_id"?: string,"id"?: string,"provider"?: string,"received_at"?: string,"requested_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "forwarding_confirmations_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    }
                  ]
                },"jobs_dedupe": {
                  Row: {
                    "created_at": string,"key": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"key": string
                  }
                  Update: {
                    "created_at"?: string,"key"?: string
                  }
                  Relationships: [
                    
                  ]
                },"messages": {
                  Row: {
                    "attachment_count": number | null,"auth_dkim": string | null,"auth_dmarc": string | null,"auth_spf": string | null,"clean_text": string | null,"created_at": string,"expires_at": string,"extraction": Json | null,"feed_id": string,"id": string,"language": string | null,"message_id_header": string | null,"original_sender": string | null,"original_subject": string | null,"pages_for_ai": number | null,"parse_attempts": number,"parse_details": Json | null,"parsed_at": string | null,"quarantine_reason": string | null,"raw_bytes": number | null,"received_at": string,"reference_date": string | null,"reference_date_source": string | null,"sender": string | null,"sha256": string | null,"source_id": string | null,"status": string,"storage_path": string | null,"stripped_text": string | null,"subject": string | null,"triaged_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attachment_count"?: number | null,"auth_dkim"?: string | null,"auth_dmarc"?: string | null,"auth_spf"?: string | null,"clean_text"?: string | null,"created_at"?: string,"expires_at"?: string,"extraction"?: Json | null,"feed_id": string,"id"?: string,"language"?: string | null,"message_id_header"?: string | null,"original_sender"?: string | null,"original_subject"?: string | null,"pages_for_ai"?: number | null,"parse_attempts"?: number,"parse_details"?: Json | null,"parsed_at"?: string | null,"quarantine_reason"?: string | null,"raw_bytes"?: number | null,"received_at"?: string,"reference_date"?: string | null,"reference_date_source"?: string | null,"sender"?: string | null,"sha256"?: string | null,"source_id"?: string | null,"status"?: string,"storage_path"?: string | null,"stripped_text"?: string | null,"subject"?: string | null,"triaged_at"?: string | null
                  }
                  Update: {
                    "attachment_count"?: number | null,"auth_dkim"?: string | null,"auth_dmarc"?: string | null,"auth_spf"?: string | null,"clean_text"?: string | null,"created_at"?: string,"expires_at"?: string,"extraction"?: Json | null,"feed_id"?: string,"id"?: string,"language"?: string | null,"message_id_header"?: string | null,"original_sender"?: string | null,"original_subject"?: string | null,"pages_for_ai"?: number | null,"parse_attempts"?: number,"parse_details"?: Json | null,"parsed_at"?: string | null,"quarantine_reason"?: string | null,"raw_bytes"?: number | null,"received_at"?: string,"reference_date"?: string | null,"reference_date_source"?: string | null,"sender"?: string | null,"sha256"?: string | null,"source_id"?: string | null,"status"?: string,"storage_path"?: string | null,"stripped_text"?: string | null,"subject"?: string | null,"triaged_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_source_id_fkey"
      columns: ["source_id"]
isOneToOne: false
      referencedRelation: "sources"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"deleted_at": string | null,"display_name": string | null,"id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"deleted_at"?: string | null,"display_name"?: string | null,"id": string
                  }
                  Update: {
                    "created_at"?: string,"deleted_at"?: string | null,"display_name"?: string | null,"id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reports": {
                  Row: {
                    "created_at": string,"details": string | null,"event_id": string | null,"feed_id": string,"id": string,"kind": string,"reporter_hash": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"details"?: string | null,"event_id"?: string | null,"feed_id": string,"id"?: string,"kind": string,"reporter_hash"?: string | null,"status"?: string
                  }
                  Update: {
                    "created_at"?: string,"details"?: string | null,"event_id"?: string | null,"feed_id"?: string,"id"?: string,"kind"?: string,"reporter_hash"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reports_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reports_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    }
                  ]
                },"sources": {
                  Row: {
                    "attachment_rule": Json | null,"blocked": boolean,"created_at": string,"feed_id": string,"id": string,"sender_domain": string | null,"sender_email": string | null,"trusted": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "attachment_rule"?: Json | null,"blocked"?: boolean,"created_at"?: string,"feed_id": string,"id"?: string,"sender_domain"?: string | null,"sender_email"?: string | null,"trusted"?: boolean
                  }
                  Update: {
                    "attachment_rule"?: Json | null,"blocked"?: boolean,"created_at"?: string,"feed_id"?: string,"id"?: string,"sender_domain"?: string | null,"sender_email"?: string | null,"trusted"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "sources_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    }
                  ]
                },"subscribe_clicks": {
                  Row: {
                    "count": number,"day": string,"feed_id": string,"platform": string
                  }
                  ComputedFields: never
                  Insert: {
                    "count"?: number,"day": string,"feed_id": string,"platform": string
                  }
                  Update: {
                    "count"?: number,"day"?: string,"feed_id"?: string,"platform"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "subscribe_clicks_feed_id_fkey"
      columns: ["feed_id"]
isOneToOne: false
      referencedRelation: "feeds"
      referencedColumns: ["id"]
    }
                  ]
                },"supporters": {
                  Row: {
                    "amount": number,"bmc_supporter_id": string,"created_at": string,"currency": string,"id": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"bmc_supporter_id": string,"created_at"?: string,"currency": string,"id"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "amount"?: number,"bmc_supporter_id"?: string,"created_at"?: string,"currency"?: string,"id"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "supporters_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"zip_codes": {
                  Row: {
                    "city": string,"location": unknown,"state": string,"zip": string
                  }
                  ComputedFields: never
                  Insert: {
                    "city": string,"location": unknown,"state": string,"zip": string
                  }
                  Update: {
                    "city"?: string,"location"?: unknown,"state"?: string,"zip"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "pg_all_foreign_keys": {
                  Row: {
                    "fk_columns": (unknown)[] | null,"fk_constraint_name": unknown,"fk_schema_name": unknown,"fk_table_name": unknown,"fk_table_oid": unknown,"is_deferrable": boolean | null,"is_deferred": boolean | null,"match_type": string | null,"on_delete": string | null,"on_update": string | null,"pk_columns": (unknown)[] | null,"pk_constraint_name": unknown,"pk_index_name": unknown,"pk_schema_name": unknown,"pk_table_name": unknown,"pk_table_oid": unknown
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"tap_funky": {
                  Row: {
                    "args": string | null,"is_definer": boolean | null,"is_strict": boolean | null,"is_visible": boolean | null,"kind": unknown,"langoid": unknown,"name": unknown,"oid": unknown,"owner": unknown,"returns": string | null,"returns_set": boolean | null,"schema": unknown,"volatility": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "_cleanup":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"_contract_on":
{ Args: { "": string }; Returns: unknown
                           },
"_currtest":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"_db_privs":
{ Args: Record<PropertyKey, never>; Returns: (unknown)[]
                           },
"_extensions":
{ Args: Record<PropertyKey, never>; Returns: unknown[]
                           },
"_get":
{ Args: { "": string }; Returns: number
                           },
"_get_latest":
{ Args: { "": string }; Returns: (number)[]
                           },
"_get_note":
{ Args: { "": string }; Returns: string
                           },
"_is_verbose":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"_prokind":
{ Args: { "p_oid": unknown }; Returns: unknown
                           },
"_query":
{ Args: { "": string }; Returns: string
                           },
"_refine_vol":
{ Args: { "": string }; Returns: string
                           },
"_retval":
{ Args: { "": string }; Returns: string
                           },
"_table_privs":
{ Args: Record<PropertyKey, never>; Returns: (unknown)[]
                           },
"_temptypes":
{ Args: { "": string }; Returns: string
                           },
"_todo":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"account_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"cancel_account_deletion":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"choose_attachment":
{ Args: { "p_attachment_id": string }; Returns: Json
                           },
"claim_extract_jobs":
{ Args: { "p_limit"?: number,"p_visibility_seconds"?: number }; Returns: {
              "context": Json,"feed_id": string,"job_id": number,"message_id": string
            }[]
                           },
"claim_process_jobs":
{ Args: { "p_limit"?: number,"p_visibility_seconds"?: number }; Returns: {
              "attempts": number,"feed_id": string,"job_id": number,"message_id": string,"received_at": string,"storage_path": string
            }[]
                           },
"claim_storage_trash":
{ Args: { "p_limit"?: number }; Returns: {
              "bucket": string,"id": number,"path": string
            }[]
                           },
"claim_triage_jobs":
{ Args: { "p_limit"?: number,"p_visibility_seconds"?: number }; Returns: {
              "attachment_rule": Json,"attachments": Json,"feed_id": string,"job_id": number,"message_id": string
            }[]
                           },
"col_is_null":
{ Args: { "column_name": unknown,"description"?: string,"schema_name": unknown,"table_name": unknown }; Returns: string
                           } |
{ Args: { "column_name": unknown,"description"?: string,"table_name": unknown }; Returns: string
                           },
"col_not_null":
{ Args: { "column_name": unknown,"description"?: string,"schema_name": unknown,"table_name": unknown }; Returns: string
                           } |
{ Args: { "column_name": unknown,"description"?: string,"table_name": unknown }; Returns: string
                           },
"decide_message":
{ Args: { "p_message_id": string,"p_release": boolean }; Returns: boolean
                           },
"decide_sender":
{ Args: { "p_source_id": string,"p_trust": boolean }; Returns: number
                           },
"diag":
{ Args: { "msg": unknown }; Returns: { error: true } & "Could not choose the best candidate function between: public.diag(msg => text), public.diag(msg => anyelement). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
                           } |
{ Args: { "msg": string }; Returns: { error: true } & "Could not choose the best candidate function between: public.diag(msg => text), public.diag(msg => anyelement). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
                           },
"diag_test_name":
{ Args: { "": string }; Returns: string
                           },
"do_tap":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           } |
{ Args: { "": string }; Returns: string[]
                           },
"due_account_deletions":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"fail":
{ Args: Record<PropertyKey, never>; Returns: string
                           } |
{ Args: { "": string }; Returns: string
                           },
"fail_extract_job":
{ Args: { "p_job_id": number,"p_message_id": string }; Returns: string
                           },
"fail_process_job":
{ Args: { "p_job_id": number,"p_max_attempts"?: number,"p_message_id": string }; Returns: string
                           },
"fail_triage_job":
{ Args: { "p_job_id": number,"p_message_id": string }; Returns: string
                           },
"feed_calendar":
{ Args: { "p_client_ip"?: string,"p_token": string,"p_ua_family"?: string,"p_user_agent"?: string }; Returns: Json
                           },
"feed_subscribe_stats":
{ Args: { "p_feed_id": string }; Returns: Json
                           },
"findfuncs":
{ Args: { "": string }; Returns: (string)[]
                           },
"finish":
{ Args: { "exception_on_failure"?: boolean }; Returns: string[]
                           },
"finish_extract_job":
{ Args: { "p_job_id": number }; Returns: boolean
                           },
"finish_process_job":
{ Args: { "p_job_id": number }; Returns: boolean
                           },
"finish_triage_job":
{ Args: { "p_job_id": number }; Returns: boolean
                           },
"forget_storage_trash":
{ Args: { "p_ids": (number)[] }; Returns: number
                           },
"format_type_string":
{ Args: { "": string }; Returns: string
                           },
"get_feed_token":
{ Args: { "p_feed_id": string }; Returns: string
                           },
"has_unique":
{ Args: { "": string }; Returns: string
                           },
"health_check":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"in_todo":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"ingest_commit":
{ Args: { "p_attachment_count": number,"p_body_sha256": string,"p_dkim"?: string,"p_dmarc"?: string,"p_gmail_confirmation"?: Json,"p_message_id_header": string,"p_path": string,"p_raw_bytes": number,"p_sender": string,"p_spf"?: string,"p_subject": string,"p_ticket": string }; Returns: Json
                           },
"ingest_start":
{ Args: { "p_bytes": number,"p_local_part": string }; Returns: Json
                           },
"is_empty":
{ Args: { "": string }; Returns: string
                           },
"isnt_empty":
{ Args: { "": string }; Returns: string
                           },
"lives_ok":
{ Args: { "": string }; Returns: string
                           },
"login_attempt_allowed":
{ Args: { "p_client_ip"?: string,"p_email": string }; Returns: boolean
                           },
"never_use_attachment":
{ Args: { "p_attachment_id": string }; Returns: Json
                           },
"no_plan":
{ Args: Record<PropertyKey, never>; Returns: boolean[]
                           },
"num_failed":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"os_name":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"pass":
{ Args: Record<PropertyKey, never>; Returns: string
                           } |
{ Args: { "": string }; Returns: string
                           },
"pg_version":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"pg_version_num":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"pgtap_version":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"public_feed_page":
{ Args: { "p_limit"?: number,"p_slug": string }; Returns: Json
                           },
"purge_account_data":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"reconcile_pending":
{ Args: { "p_limit"?: number }; Returns: number
                           },
"record_extraction":
{ Args: { "p_message_id": string,"p_result": Json }; Returns: number
                           },
"record_extraction_waiting":
{ Args: { "p_message_id": string,"p_reason": string }; Returns: undefined
                           },
"record_parsed_message":
{ Args: { "p_attachments": Json,"p_message_id": string,"p_parsed": Json }; Returns: string
                           },
"record_subscribe_click":
{ Args: { "p_platform": string,"p_slug": string }; Returns: boolean
                           },
"record_triage":
{ Args: { "p_message_id": string,"p_results": Json }; Returns: number
                           },
"request_account_deletion":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"requeue_waiting_extractions":
{ Args: { "p_limit"?: number }; Returns: number
                           },
"rotate_feed_token":
{ Args: { "p_feed_id": string }; Returns: string
                           },
"rotate_intake_address":
{ Args: { "p_feed_id": string }; Returns: string
                           },
"runtests":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           } |
{ Args: { "": string }; Returns: string[]
                           },
"set_sender_large_attachments":
{ Args: { "p_allow": boolean,"p_source_id": string }; Returns: boolean
                           },
"skip":
{ Args: { "": string }; Returns: string
                           } |
{ Args: { "how_many": number,"why": string }; Returns: string
                           },
"state_machines":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"take_quota":
{ Args: { "p_feed_id": string,"p_kind": string,"p_wanted": number }; Returns: number
                           },
"throws_ok":
{ Args: { "": string }; Returns: string
                           },
"todo":
{ Args: { "how_many": number }; Returns: boolean[]
                           } |
{ Args: { "how_many": number,"why": string }; Returns: boolean[]
                           } |
{ Args: { "why": string }; Returns: boolean[]
                           } |
{ Args: { "how_many": number,"why": string }; Returns: boolean[]
                           },
"todo_end":
{ Args: Record<PropertyKey, never>; Returns: boolean[]
                           },
"todo_start":
{ Args: Record<PropertyKey, never>; Returns: boolean[]
                           } |
{ Args: { "": string }; Returns: boolean[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            "_time_trial_type": {
                        "a_time": number | null
                      }
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
