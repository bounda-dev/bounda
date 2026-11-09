# The master key every person's key is wrapped under, so a copy of the database opens none of
# their data without it: 32 random bytes in base64, generated for this project. Keep it secret
# and out of version control. https://docs.bounda.dev/guides/personal-data/#where-the-keys-live
BOUNDA_MASTER_KEY={{masterKey}}
# Development only: the logs carry the message and the stack of errors, which may quote personal
# data. Leave it unset when you deploy. https://docs.bounda.dev/reference/observability/#error-text
BOUNDA_ERROR_TEXT=include
