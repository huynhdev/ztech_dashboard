export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      doctors: {
        Row: {
          created_at: string
          id: number
          lab_id: number | null
          name: string
          raw: string
          route: string | null
        }
        Insert: {
          created_at?: string
          id?: never
          lab_id?: number | null
          name: string
          raw: string
          route?: string | null
        }
        Update: {
          created_at?: string
          id?: never
          lab_id?: number | null
          name?: string
          raw?: string
          route?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "doctors_lab_id_fkey"
            columns: ["lab_id"]
            isOneToOne: false
            referencedRelation: "labs"
            referencedColumns: ["id"]
          },
        ]
      }
      incoming_cases: {
        Row: {
          amount: number
          created_at: string
          dedupe_key: string
          doctor_id: number | null
          id: number
          is_multi_unit: boolean
          lab_id: number | null
          order_date: string
          pan: string | null
          patient_id: number | null
          product_id: number | null
          source_file: string | null
          status: string | null
          upload_id: string | null
        }
        Insert: {
          amount?: number
          created_at?: string
          dedupe_key: string
          doctor_id?: number | null
          id?: never
          is_multi_unit?: boolean
          lab_id?: number | null
          order_date: string
          pan?: string | null
          patient_id?: number | null
          product_id?: number | null
          source_file?: string | null
          status?: string | null
          upload_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          dedupe_key?: string
          doctor_id?: number | null
          id?: never
          is_multi_unit?: boolean
          lab_id?: number | null
          order_date?: string
          pan?: string | null
          patient_id?: number | null
          product_id?: number | null
          source_file?: string | null
          status?: string | null
          upload_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "incoming_cases_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incoming_cases_lab_id_fkey"
            columns: ["lab_id"]
            isOneToOne: false
            referencedRelation: "labs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incoming_cases_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incoming_cases_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incoming_cases_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      keepalive: {
        Row: {
          id: number
          pinged_at: string
        }
        Insert: {
          id: number
          pinged_at?: string
        }
        Update: {
          id?: number
          pinged_at?: string
        }
        Relationships: []
      }
      labs: {
        Row: {
          created_at: string
          id: number
          name: string
        }
        Insert: {
          created_at?: string
          id?: never
          name: string
        }
        Update: {
          created_at?: string
          id?: never
          name?: string
        }
        Relationships: []
      }
      patients: {
        Row: {
          created_at: string
          external_id: string | null
          id: number
          lab_id: number | null
          name: string
        }
        Insert: {
          created_at?: string
          external_id?: string | null
          id?: never
          lab_id?: number | null
          name: string
        }
        Update: {
          created_at?: string
          external_id?: string | null
          id?: never
          lab_id?: number | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "patients_lab_id_fkey"
            columns: ["lab_id"]
            isOneToOne: false
            referencedRelation: "labs"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          category: string | null
          created_at: string
          id: number
          name: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: never
          name: string
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: never
          name?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          role: Database["public"]["Enums"]["user_role"]
          status: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          role?: Database["public"]["Enums"]["user_role"]
          status?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          status?: string
        }
        Relationships: []
      }
      uploads: {
        Row: {
          error: string | null
          file_hash: string | null
          file_name: string
          file_path: string | null
          id: string
          inserted_count: number
          new_doctors_count: number
          new_labs_count: number
          processed_rows: number
          skipped_count: number
          status: Database["public"]["Enums"]["upload_status"]
          total_rows: number | null
          updated_count: number
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          error?: string | null
          file_hash?: string | null
          file_name: string
          file_path?: string | null
          id?: string
          inserted_count?: number
          new_doctors_count?: number
          new_labs_count?: number
          processed_rows?: number
          skipped_count?: number
          status?: Database["public"]["Enums"]["upload_status"]
          total_rows?: number | null
          updated_count?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          error?: string | null
          file_hash?: string | null
          file_name?: string
          file_path?: string | null
          id?: string
          inserted_count?: number
          new_doctors_count?: number
          new_labs_count?: number
          processed_rows?: number
          skipped_count?: number
          status?: Database["public"]["Enums"]["upload_status"]
          total_rows?: number | null
          updated_count?: number
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_dashboard_overview: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      import_upload_chunk: {
        Args: { p_rows: Json; p_source_file: string; p_upload_id: string }
        Returns: {
          inserted_count: number
          new_doctors_count: number
          new_labs_count: number
          updated_count: number
        }[]
      }
      invoke_keepalive_edge_function: { Args: never; Returns: undefined }
      is_admin: { Args: never; Returns: boolean }
    }
    Enums: {
      upload_status: "pending" | "processing" | "completed" | "failed"
      user_role: "admin" | "operator" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      upload_status: ["pending", "processing", "completed", "failed"],
      user_role: ["admin", "operator", "viewer"],
    },
  },
} as const

