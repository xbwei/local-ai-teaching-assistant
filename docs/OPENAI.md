# Optional OpenAI / Compare

Local remains the default and works with no OpenAI credential. Start with [Local setup](GETTING-STARTED.md).

## Optional OpenAI and Compare

Use your own OpenAI API account/key; usage incurs your provider's API charges. The server resolves a one-use secret handle from **macOS Keychain**. There is no plaintext key configuration option. Never put a key in `.env`, JSON, browser storage, SQLite, logs, tests, screenshots or Git.

Use the macOS Keychain Access app to create a **password item** named `org.laita.openai` with account `laita-operator` and enter the secret in the password field. Alternatively, this terminal command prompts for the secret interactively, without placing it in shell history:

```bash
/usr/bin/security add-generic-password -U -s org.laita.openai -a laita-operator -w
```

Run the command in your own interactive terminal; respond to its password prompt. Do not add a `-w actual-key` argument. The Keychain item must be accessible to the account running the API. OS permission prompts or inaccessible items are failures, not reasons to add plaintext fallback.

Edit only the non-secret operator JSON:

```json
{
  "features": { "local": true, "openai": true, "compare": true, "speech": false },
  "providers": {
    "openai": {
      "provider": "OPENAI",
      "model": "gpt-5.6-luna",
      "secretReference": { "kind": "opaque", "id": "laita-openai-primary" }
    }
  }
}
```

This is a **fragment**, not a complete config: retain the existing Local provider, provenance, access, runtime and server fields. The accepted OpenAI model is `gpt-5.6-luna`; account/model availability must be checked by you. No live Cloud validation or API spend is part of the candidate's automated tests.

Restart the foreground API with non-secret mapping names:

```bash
LAITA_OPENAI_KEYCHAIN_SERVICE=org.laita.openai \
LAITA_OPENAI_KEYCHAIN_ACCOUNT=laita-operator \
APP_CONFIG_JSON="$(cat "$HOME/.local/share/laita/config/application.json")" npm start
```

A missing mapping disables availability. A mapped but missing/inaccessible item is reported on execution as credential/provider failure; startup health is not proof the item exists. Local remains usable and there is no silent fallback. To disable Cloud, restore the two flags to false and the reference to null, then restart without the mapping environment variables.

To rotate, update the same Keychain item using Keychain Access or repeat the interactive `add-generic-password -U` command, then start a fresh API process. To remove it:

```bash
/usr/bin/security delete-generic-password -s org.laita.openai -a laita-operator
```

Disable Cloud in configuration too. Removing a key does not erase already retained text. [Deployment details](DEPLOYMENT.md) cover LaunchAgent mapping and local service operations.
