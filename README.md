To install dependencies:

```sh
bun install
```

To run:

```sh
bun run dev
```

open http://localhost:3000

To expose on port 80 run this command from root project directory:

```sh
docker run -it -v .:/home/bun/app -p 3000:3000 -p 80:3000 oven/bun bun dev
```
