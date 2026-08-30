import {
  type FormAuthorityIdentityProbeEnv,
  handleFormAuthorityIdentityProbe,
} from "./form-authority-identity-probe.ts";

export default {
  async fetch(request: Request, env: FormAuthorityIdentityProbeEnv): Promise<Response> {
    return await handleFormAuthorityIdentityProbe(request, env);
  },
};
