# Little Counter

Little Counter is a self-hosted point-of-sale system for small shops and market stalls. Staff can ring up sales, track stock and reconcile a shift. Customers can scan shelf labels and bring a cart QR code to the counter.

Little Counter is a nonprofit project. Its MIT license lets individuals and businesses fork the code, customize it and use it commercially.

## What’s included

| Area | Source |
| --- | --- |
| Cashier interface and customer checkout | [Point of sale](apps/pos/) · [Scan & Go](apps/customer/) |
| Commerce API, business rules and shared types | [API](src/api/) · [Packages](packages/) |
| Accounting, messaging and assistant integrations | [Accounting](plugins/accounting/) · [Telegram](apps/telegram/) · [AI service](apps/ai/) |
| Database migrations and container builds | [SQL](db/migrations/) · [Dockerfile](docker/Dockerfile) |

## Build and test

Use Node.js 24 and npm from the repository root.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## Using an existing installation

The initial public release is based on application version **2.3.0**. To check a restored installation, supply its connection string through the `MIGRATION_DATABASE_URL` environment variable and run `npm run db:check`. The command compares the database’s migration history with the SQL files in a read-only transaction. A matching 2.3.0 installation has 82 entries.

Provide the existing database connections, signing and encryption keys, and storage configuration through the runtime environment. Preserve historical migration files when maintaining a fork and use new migrations for schema changes. [Environment example](.env.example)

## License

The original project code is distributed under the MIT License. You may use, modify, distribute and sell copies. Keep the copyright and permission notices in copies or substantial portions of the software. The software is provided without warranty. [MIT License](LICENSE)

Dependencies and base images retain their own licenses. Medusa 2.19.0 includes separately licensed Enterprise materials. Review the upstream terms when using these components or redistributing a built image. [Third-party notices](THIRD-PARTY-NOTICES)
