.DEFAULT_GOAL := help
MAKEFLAGS    += --no-print-directory

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0,5) }' $(MAKEFILE_LIST)

##@ Run

.PHONY: run
run: upgrade-libs ## Run the extract job — ENV=dev|prod required  (e.g. make run ENV=dev)
	@[ -n "$(ENV)" ] || (echo "Usage: make run ENV=dev|prod"; exit 1)
	bash cicd/start-up.sh $(ENV)

##@ Dev

.PHONY: upgrade-libs
upgrade-libs: ## Re-resolve all meridian-common-libs packages to their latest commits on main
	uv lock --upgrade-package py-logging --upgrade-package py-db-migrate --upgrade-package py-google-workspace --upgrade-package py-db-schema

.PHONY: generate-models
generate-models: ## Regenerate typed model files (spins up a fresh Docker PostgreSQL container — requires Docker running)
	uv run py-db-schema generate --db postgres
