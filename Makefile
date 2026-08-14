.DEFAULT_GOAL := help
MAKEFLAGS    += --no-print-directory

# ── Help (self-documenting) ───────────────────────────────────────────────────

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0,5) }' $(MAKEFILE_LIST)

##@ Infrastructure

.PHONY: infra-up
infra-up: ## Create network and start PostgreSQL
	docker network create fulcrum-net 2>/dev/null || true
	bash infrastructure/start-services.sh

.PHONY: infra-down
infra-down: ## Stop PostgreSQL and remove network
	bash infrastructure/stop-services.sh
	docker network rm fulcrum-net 2>/dev/null || true

##@ App

.PHONY: app-start
app-start: ## Start local HTTP server → http://localhost:8000/expense-tracker/app/
	@if [ -f .server.pid ] && kill -0 $$(cat .server.pid) 2>/dev/null; then \
		echo "Server already running (PID $$(cat .server.pid)) → http://localhost:8000/expense-tracker/app/"; \
	elif lsof -ti :8000 > /dev/null 2>&1; then \
		OTHER_PID=$$(lsof -ti :8000 | head -1); \
		echo "Port 8000 is in use by PID $$OTHER_PID."; \
		echo "  1) Kill it and start the server"; \
		echo "  2) Exit — I'll handle it myself"; \
		printf "#? "; read -r CHOICE; \
		if [ "$$CHOICE" = "1" ]; then \
			kill $$OTHER_PID && rm -f .server.pid; \
			python3 -m http.server 8000 --directory . > /dev/null 2>&1 & echo $$! > .server.pid; \
			echo "Server started (PID $$(cat .server.pid)) → http://localhost:8000/expense-tracker/app/"; \
		else \
			echo "Run: kill $$OTHER_PID — then re-run make app-start."; \
			exit 1; \
		fi; \
	else \
		python3 -m http.server 8000 --directory . > /dev/null 2>&1 & echo $$! > .server.pid; \
		echo "Server started (PID $$(cat .server.pid)) → http://localhost:8000/expense-tracker/app/"; \
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
api-deploy: ## Deploy GAS backend (interactive: pick env)
	bash expense-tracker/cicd/deploy.sh

.PHONY: api-logs
api-logs: ## Open GAS executions page in browser (interactive: pick env)
	bash expense-tracker/cicd/logs.sh

##@ Data Synchronization

.PHONY: data-sync
data-sync: ## Run a data-synchronization module (interactive: pick module + env)
	@echo ""; \
	i=1; \
	for dir in data-synchronization/*/; do \
		[ -f "$${dir}cicd/start-up.sh" ] && printf "  %d) %s\n" "$$i" "$$(basename $$dir)" && i=$$((i+1)); \
	done; \
	echo ""; \
	printf "Select module: "; read -r CHOICE; \
	i=1; \
	selected=""; \
	for dir in data-synchronization/*/; do \
		if [ -f "$${dir}cicd/start-up.sh" ]; then \
			[ "$$i" = "$$CHOICE" ] && selected="$$dir" && break; \
			i=$$((i+1)); \
		fi; \
	done; \
	if [ -z "$$selected" ]; then \
		echo "Invalid choice '$$CHOICE'."; exit 1; \
	fi; \
	echo ""; \
	echo "  1) dev"; \
	echo "  2) prod"; \
	echo ""; \
	printf "Select environment: "; read -r ENV_CHOICE; \
	if [ "$$ENV_CHOICE" = "1" ]; then ENV="dev"; \
	elif [ "$$ENV_CHOICE" = "2" ]; then ENV="prod"; \
	else echo "Invalid choice '$$ENV_CHOICE'. Enter 1 or 2."; exit 1; \
	fi; \
	bash "$${selected}cicd/start-up.sh" "$$ENV"

##@ Job

.PHONY: job-setup
job-setup: ## Create venv and install job dependencies
	python3 -m venv expense-tracker/job/.venv
	expense-tracker/job/.venv/bin/pip install -r expense-tracker/job/requirements.txt
	@echo "Setup done. venv is at expense-tracker/job/.venv"

.PHONY: job-start
job-start: ## Run expense-tracker jobs (ENV=dev|prod, JOB=name optional)
	@echo ""; \
	echo "  1) dev"; \
	echo "  2) prod"; \
	echo ""; \
	printf "Select environment: "; read -r CHOICE; \
	if [ "$$CHOICE" = "1" ]; then ENV="dev"; \
	elif [ "$$CHOICE" = "2" ]; then ENV="prod"; \
	else echo "Invalid choice '$$CHOICE'. Enter 1 or 2."; exit 1; \
	fi; \
	JOB_ARG=$${JOB:+--job $$JOB}; \
	expense-tracker/job/.venv/bin/python expense-tracker/job/runner.py --env $$ENV $$JOB_ARG
