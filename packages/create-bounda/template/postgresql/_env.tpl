# The master key every person's key is wrapped under, so a copy of the database opens none of
# their data without it: 32 random bytes in base64, generated for this project. Keep it secret
# and out of version control. https://docs.bounda.dev/guides/personal-data/#where-the-keys-live
BOUNDA_MASTER_KEY={{masterKey}}

# Where the database is, as in .env.example.
# DATABASE_URL=postgres://user:password@localhost:5432/{{name}}
