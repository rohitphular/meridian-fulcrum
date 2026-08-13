.PHONY: generate-models

generate-models: ## Regenerate typed model files from live schema (requires Docker)
	uv run py-db-schema generate --db postgres
