To install dependencies:

```sh
bun install
```

To run:

```sh
bun run dev
```

open http://localhost:3000

To expose on port 80:

```sh
docker run -d --network=host caddy caddy reverse-proxy --from :80 --to :3000 --access-log
```
