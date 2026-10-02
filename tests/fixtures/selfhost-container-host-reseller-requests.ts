export type HostJsonPost = (
  path: string,
  expectedStatus: number,
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => Promise<Record<string, unknown>>;

export interface ResellerProvisionRequest {
  readonly tenantRef: string;
  readonly offeringId: string;
  readonly resourceName: string;
  readonly quantity: number;
  readonly tokenExpiresInSeconds: number;
  readonly apiKey: Record<string, string>;
}

export interface ResellerProvisionResult {
  readonly quoteId: string;
  readonly reservationId: string;
  readonly provisionAuthorization: { readonly authorization: string };
}

export interface CapturedManagementRequest {
  readonly reservationId: string;
  readonly tenantRef: string;
  readonly resourceName: string;
  readonly resourceUid: string;
  readonly captureQuantity: number;
  readonly tokenExpiresInSeconds: number;
  readonly apiKey: Record<string, string>;
}

export interface CaptureStatement {
  readonly reservationId: string;
  readonly tenantRef: string;
  readonly offeringId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly usage: { readonly meter: string; readonly quantity: number };
  readonly capturedAt: string;
}

export interface CapturedManagementResult {
  readonly captureStatement: CaptureStatement;
  readonly managementAuthorization: { readonly authorization: string };
}

export async function createResellerProvision(
  post: HostJsonPost,
  input: ResellerProvisionRequest,
): Promise<ResellerProvisionResult> {
  const quote = await post(
    "/v1/reseller/quotes",
    201,
    {
      tenantRef: input.tenantRef,
      offeringId: input.offeringId,
      quantity: input.quantity,
    },
    input.apiKey,
  );
  const quoteId = String((quote as { quote: { id: string } }).quote.id);
  const reservation = await post(
    "/v1/reseller/reservations",
    201,
    { tenantRef: input.tenantRef, quoteId },
    input.apiKey,
  );
  const reservationId = String((reservation as { reservation: { id: string } }).reservation.id);
  const issued = await post(
    `/v1/reseller/reservations/${reservationId}/takoform-run-tokens`,
    201,
    {
      tenantRef: input.tenantRef,
      resourceName: input.resourceName,
      expiresInSeconds: input.tokenExpiresInSeconds,
    },
    input.apiKey,
  );
  return {
    quoteId,
    reservationId,
    provisionAuthorization: {
      authorization: `Bearer ${String(
        (issued as { takoformRunToken: { token: string } }).takoformRunToken.token,
      )}`,
    },
  };
}

export async function captureAndIssueManagement(
  post: HostJsonPost,
  input: CapturedManagementRequest,
): Promise<CapturedManagementResult> {
  const capture = await post(
    `/v1/reseller/reservations/${input.reservationId}/capture`,
    200,
    {
      tenantRef: input.tenantRef,
      usage: { quantity: input.captureQuantity },
    },
    input.apiKey,
  );
  const issued = await post(
    `/v1/reseller/reservations/${input.reservationId}/takoform-run-tokens`,
    201,
    {
      tenantRef: input.tenantRef,
      resourceName: input.resourceName,
      resourceUid: input.resourceUid,
      expiresInSeconds: input.tokenExpiresInSeconds,
    },
    input.apiKey,
  );
  return {
    captureStatement: (capture as { statement: CaptureStatement }).statement,
    managementAuthorization: {
      authorization: `Bearer ${String(
        (issued as { takoformRunToken: { token: string } }).takoformRunToken.token,
      )}`,
    },
  };
}
