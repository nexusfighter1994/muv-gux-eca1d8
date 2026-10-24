# VidForge stock image + vf-custom layer (home-PC boost, server boost, Custom tab).
# Update: pin BASE; require the hook gate, compatibility tests, backup and live verification.
ARG BASE=afflicted9436/tayzu31t3@sha256:4c26a7fe069c3b3b4b5898d0782890996ec1a0f1eb5e7abe4aa5a973704c58b3
FROM ${BASE}
USER root
ENV VF_MODS_BOOTSTRAP=1 VF_MODS_DATABASE=/data/vidforge.db
COPY . /opt/vf-custom
RUN python3 /opt/vf-custom/apply.py
RUN node /opt/vf-custom/update-tools/verify-siglip-callbacks.mjs /app/server/dist/index.mjs /app/server/dist/vf-custom/home-siglip.mjs
RUN node /opt/vf-custom/update-tools/verify-home-callbacks.mjs /app/server/dist/index.mjs /app/server/dist/vf-custom
LABEL org.vidforge.custom.contract="vf-custom-41-20261023" \
      org.vidforge.custom.upstream-version="2026.10.22.12"
