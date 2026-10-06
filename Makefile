.DEFAULT_GOAL := help

# ENV=<name> answers the environment question for any target (dev, prod, or any
# env in infrastructure/envs.json); without it, each target asks once.
ENV ?=
MAKEFLAGS    += --no-print-directory

# ── Help (self-documenting) ───────────────────────────────────────────────────

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0,5) }' $(MAKEFILE_LIST)

##@ Infrastructure

.PHONY: infra-up
infra-up: ## Start PostgreSQL for an environment (asks for the env; ENV=name skips the question)
	@ENV="$$(bash infrastructure/select-env.sh "$(ENV)")" || exit 1; \
	bash infrastructure/start-services.sh "$$ENV"

.PHONY: infra-down
infra-down: ## Stop PostgreSQL for an environment (asks for the env; ENV=name skips the question)
	@ENV="$$(bash infrastructure/select-env.sh "$(ENV)")" || exit 1; \
	bash infrastructure/stop-services.sh "$$ENV"

##@ App

.PHONY: app-start
app-start: ## Start local HTTP server → http://localhost:8000/codebase/expense-tracker/app/
	@if [ -f .server.pid ] && kill -0 $$(cat .server.pid) 2>/dev/null; then \
		echo "Server already running (PID $$(cat .server.pid)) → http://localhost:8000/codebase/expense-tracker/app/"; \
	elif lsof -ti :8000 > /dev/null 2>&1; then \
		OTHER_PID=$$(lsof -ti :8000 | head -1); \
		echo "Port 8000 is in use by PID $$OTHER_PID."; \
		echo "  1) Kill it and start the server"; \
		echo "  2) Exit — I'll handle it myself"; \
		printf "#? "; read -r CHOICE; \
		if [ "$$CHOICE" = "1" ]; then \
			kill $$OTHER_PID && rm -f .server.pid; \
			python3 -m http.server 8000 --bind 127.0.0.1 --directory . > /dev/null 2>&1 & echo $$! > .server.pid; \
			echo "Server started (PID $$(cat .server.pid)) → http://localhost:8000/codebase/expense-tracker/app/"; \
		else \
			echo "Run: kill $$OTHER_PID — then re-run make app-start."; \
			exit 1; \
		fi; \
	else \
		python3 -m http.server 8000 --bind 127.0.0.1 --directory . > /dev/null 2>&1 & echo $$! > .server.pid; \
		echo "Server started (PID $$(cat .server.pid)) → http://localhost:8000/codebase/expense-tracker/app/"; \
	fi

.PHONY: app-stop
app-stop: ## Stop the local HTTP server
	@if [ -f .server.pid ] && kill -0 $$(cat .server.pid) 2>/dev/null; then \
		kill $$(cat .server.pid) && rm -f .server.pid; \
		echo "Server stopped."; \
	else \
		rm -f .server.pid; \
		echo "Server is not running."; \
	fi

.PHONY: api-deploy
api-deploy: ## Deploy GAS backend (asks for the env and a description; ENV=name and DESC="..." skip them)
	@ENV="$$(bash infrastructure/select-env.sh "$(ENV)")" || exit 1; \
	bash codebase/expense-tracker/cicd/deploy.sh "$$ENV" $(if $(DESC),"$(DESC)")

.PHONY: api-logs
api-logs: ## Open GAS executions page in browser (asks for the env; ENV=name skips the question)
	@ENV="$$(bash infrastructure/select-env.sh "$(ENV)")" || exit 1; \
	bash codebase/expense-tracker/cicd/logs.sh "$$ENV"

##@ Data Synchronization

.PHONY: data-sync
data-sync: ## Run one data-synchronization module interactively (pick module + env, ENV=name skips the env question; the module asks for its own mode)
	@echo ""; \
	i=1; \
	for dir in codebase/data-synchronization/*/; do \
		[ -f "$${dir}cicd/start-up.sh" ] && [ "$$(basename $$dir)" != consolidated-pipeline ] && printf "  %d) %s\n" "$$i" "$$(basename $$dir)" && i=$$((i+1)); \
	done; \
	echo ""; \
	printf "Select module: "; read -r CHOICE; \
	i=1; \
	selected=""; \
	for dir in codebase/data-synchronization/*/; do \
		if [ -f "$${dir}cicd/start-up.sh" ] && [ "$$(basename $$dir)" != consolidated-pipeline ]; then \
			[ "$$i" = "$$CHOICE" ] && selected="$$dir" && break; \
			i=$$((i+1)); \
		fi; \
	done; \
	if [ -z "$$selected" ]; then \
		echo "Invalid choice '$$CHOICE'."; exit 1; \
	fi; \
	ENV="$$(bash infrastructure/select-env.sh "$(ENV)")" || exit 1; \
	bash "$${selected}cicd/start-up.sh" --interactive "$$ENV"

.PHONY: consolidated-pipeline
consolidated-pipeline: ## Start PostgreSQL (infra-up), then run the pipeline — one env question for both; ENV=name or CONFIG=path skips it
	@if [ -n "$(CONFIG)" ]; then \
		ENV="$$(python3 codebase/data-synchronization/consolidated-pipeline/cicd/read-stage.py "$(CONFIG)" --env | sed -n 's/^env=//p')"; \
		[ -n "$$ENV" ] || exit 1; \
	fi; \
	ENV="$$(bash infrastructure/select-env.sh "$${ENV:-$(ENV)}")" || exit 1; \
	$(MAKE) infra-up ENV="$$ENV" || exit 1; \
	if [ -n "$(CONFIG)" ]; then \
		bash codebase/data-synchronization/consolidated-pipeline/cicd/start-up.sh --config "$(CONFIG)"; \
	else \
		bash codebase/data-synchronization/consolidated-pipeline/cicd/start-up.sh --env "$$ENV"; \
	fi
