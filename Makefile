.PHONY: install dev test typecheck build demo-replay generate probe-models limitations

install:
	npm install

dev:
	npm run dev

test:
	npm run build -w @liara-agent/shared
	npm test

typecheck:
	npm run build -w @liara-agent/shared
	npm run typecheck

build:
	npm run build

demo-replay:
	npm run build -w @liara-agent/shared
	npm run demo:replay

generate:
	npm run generate:liara

probe-models:
	npm run probe:models

limitations:
	npm run docs:limitations
