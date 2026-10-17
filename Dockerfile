# VidForge stock image + vf-custom layer (home-PC boost, server boost, Custom tab).
# Update: pin BASE; require the hook gate, compatibility tests, backup and live verification.
ARG BASE=afflicted9436/tayzu31t3@sha256:f1e9c60fdfb3593d747bc3c2aa56bd8700a2c23f3706ba60459c282c6b520c67
FROM ${BASE}
USER root
ENV VF_MODS_BOOTSTRAP=1 VF_MODS_DATABASE=/data/vidforge.db
COPY . /opt/vf-custom
RUN python3 /opt/vf-custom/apply.py
LABEL org.vidforge.custom.contract="vf-custom-40-20261015" \
      org.vidforge.custom.upstream-version="2026.10.13.7"
