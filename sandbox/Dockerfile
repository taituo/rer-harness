# What the doer has to work with. Everything is installed at build time, because the container has no network.
# Pin versions you care about; the image ID is printed by start.sh and should be recorded with the run.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git curl nodejs npm \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir numpy scipy torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir matplotlib pytest sympy hypothesis
