.DEFAULT_GOAL := help
MAKEFLAGS    += --no-print-directory

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0,5) }' $(MAKEFILE_LIST)

##@ Run

.PHONY: run
run: ## Run every stage in pipeline.json — CONFIG=path optional  (e.g. make run CONFIG=nightly.json)
	bash cicd/start-up.sh $(if $(CONFIG),--config "$(CONFIG)")

##@ Dev

.PHONY: lint
lint: ## Lint and format-check — must pass before deploy
	uv run --locked ruff check .
	uv run --locked ruff format --check .

.PHONY: upgrade-libs
upgrade-libs: ## Re-resolve all meridian-common-libs packages to their latest commits on main
	uv lock --upgrade-package py-logging

.PHONY: test test-unit
test: ## Run all tests
	uv run --locked python -m pytest

test-unit: ## Run offline tests without external services
	uv run --locked python -m pytest tests/unit
