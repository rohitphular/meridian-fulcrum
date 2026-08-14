.PHONY: generate-models

generate-models: ## Regenerate typed model files (spins up a fresh Docker PostgreSQL container — requires Docker running)
	uv run py-db-schema generate --db postgres
