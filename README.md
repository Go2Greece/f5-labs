# f5-labs

F5 lab simulator for the grahammattingley.eu courses.

- Cloudflare Worker (`src/`) plus static pages (`public/`)
- MongoDB Atlas for users, access, lab definitions and progress
- Deploys automatically when this repository changes

## Secrets (set in the Cloudflare dashboard, never in this repository)

| Name | What it is |
|---|---|
| `MONGODB_URI` | Atlas connection string, including the database user's password |

## Check

`/api/health` writes one record to Atlas and reads it back.
