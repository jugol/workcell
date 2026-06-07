import { SECRET_PROVIDERS, type SecretProvider } from "@workcell/shared";

export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = process.env.WORKCELL_SECRETS_PROVIDER;
  return configuredProvider && SECRET_PROVIDERS.includes(configuredProvider as SecretProvider)
    ? configuredProvider as SecretProvider
    : "local_encrypted";
}
