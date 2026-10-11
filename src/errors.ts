export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  get reason(): string | undefined {
    const reason = this.details.reason;
    return typeof reason === "string" ? reason : undefined;
  }

  get requestId(): string | undefined {
    const requestId = this.details.request_id;
    return typeof requestId === "string" ? requestId : undefined;
  }
}

export class PromptRefError extends ApiError {
  override name = "PromptRefError";
}
export class PromptRenderError extends ApiError {
  override name = "PromptRenderError";
}
export class PromptTemplateError extends ApiError {
  override name = "PromptTemplateError";
}
export class PromptIntegrityError extends ApiError {
  override name = "PromptIntegrityError";
}
export class PromptBindingError extends ApiError {
  override name = "PromptBindingError";
}

type ApiErrorClass = new (code: string, status: number, message: string, details?: Record<string, unknown>) => ApiError;

const CODE_CLASSES: ReadonlyMap<string, ApiErrorClass> = new Map<string, ApiErrorClass>([
  ["prompt_ref_invalid", PromptRefError],
  ["prompt_ref_unversioned", PromptRefError],
  ["prompt_ref_cross_workspace", PromptRefError],
  ["workspace_mismatch", PromptRefError],
  ["prompt_template_invalid", PromptTemplateError],
  ["prompt_secret_detected", PromptTemplateError],
  ["prompt_content_too_large", PromptTemplateError],
  ["prompt_kind_mismatch", PromptTemplateError],
  ["prompt_fragment_cycle", PromptTemplateError],
  ["prompt_fragment_depth_exceeded", PromptTemplateError],
  ["prompt_render_error", PromptRenderError],
  ["prompt_digest_mismatch", PromptIntegrityError],
  ["manifest_digest_mismatch", PromptIntegrityError],
  ["bundle_signature_invalid", PromptIntegrityError],
  ["bundle_untrusted_key", PromptIntegrityError],
  ["bundle_incomplete", PromptIntegrityError],
  ["bundle_expired", PromptIntegrityError],
  ["bundle_scope_mismatch", PromptIntegrityError],
  ["bundle_ungoverned", PromptIntegrityError],
  ["artifact_integrity_error", PromptIntegrityError],
  ["binding_mismatch", PromptBindingError],
  ["child_agent_not_pinned", PromptBindingError],
  ["slot_not_in_manifest", PromptBindingError],
  ["execution_binding_conflict", PromptBindingError],
  ["child_agent_conflict", PromptBindingError],
  ["release_not_bindable", PromptBindingError],
  ["session_required", PromptBindingError],
]);

export function apiError(code: string, status: number, message: string, details: Record<string, unknown> = {}): ApiError {
  const ErrorClass = CODE_CLASSES.get(code) ?? ApiError;
  return new ErrorClass(code, status, message, details);
}

export function integrityError(code: string, message: string, details: Record<string, unknown> = {}): PromptIntegrityError {
  return new PromptIntegrityError(code, 0, message, details);
}

export function bindingError(code: string, message: string, details: Record<string, unknown> = {}): PromptBindingError {
  return new PromptBindingError(code, 0, message, details);
}
