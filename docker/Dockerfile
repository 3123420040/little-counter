FROM node:20-alpine AS manifests
WORKDIR /app
RUN apk upgrade --no-cache
COPY .npmrc package.json package-lock.json ./
COPY apps/ai/package.json apps/ai/package.json
COPY apps/customer/package.json apps/customer/package.json
COPY apps/pos/package.json apps/pos/package.json
COPY apps/pricing/package.json apps/pricing/package.json
COPY apps/telegram/package.json apps/telegram/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY plugins/accounting/package.json plugins/accounting/package.json

FROM manifests AS web-builder
RUN npm ci -w apps/pos -w apps/customer -w apps/pricing -w packages/ui --no-audit --no-fund
COPY tsconfig.base.json ./
COPY apps/pos/ apps/pos/
COPY apps/customer/ apps/customer/
COPY apps/pricing/ apps/pricing/
COPY packages/ packages/
ARG VITE_MANUAL_BANK_CONFIRMATION_ENABLED=false
ARG VITE_STORE_NAME
ARG VITE_STORE_ADDRESS
RUN npm run build -w apps/pos && \
    VITE_SCAN_GO_LIVE=1 VITE_CUSTOMER_BASE=/customer/ npm run build -w apps/customer && \
    npm run build -w apps/pricing

FROM nginxinc/nginx-unprivileged:alpine AS web
USER root
RUN apk upgrade --no-cache
USER 101
EXPOSE 8080

FROM web AS pos
ARG RELEASE_SOURCE_COMMIT=unknown
ARG RELEASE_PRODUCT_VERSION=2.3.0
LABEL org.opencontainers.image.revision="${RELEASE_SOURCE_COMMIT}" \
      org.opencontainers.image.version="${RELEASE_PRODUCT_VERSION}"
COPY --from=web-builder --chown=101:101 /app/apps/pos/dist /usr/share/nginx/html
COPY --from=web-builder --chown=101:101 /app/apps/customer/dist /usr/share/nginx/html/customer
COPY --chown=101:101 docker/nginx-pos.conf /etc/nginx/conf.d/default.conf

FROM web AS pricing
COPY --from=web-builder --chown=101:101 /app/apps/pricing/dist /usr/share/nginx/html
COPY --chown=101:101 docker/nginx-pricing.conf /etc/nginx/conf.d/default.conf

FROM manifests AS medusa
ARG RELEASE_SOURCE_COMMIT=unknown
ARG RELEASE_PRODUCT_VERSION=2.3.0
LABEL org.opencontainers.image.revision="${RELEASE_SOURCE_COMMIT}" \
      org.opencontainers.image.version="${RELEASE_PRODUCT_VERSION}"
ENV BUILD_SOURCE_COMMIT=${RELEASE_SOURCE_COMMIT} \
    BUILD_RELEASE_ID=snus-${RELEASE_PRODUCT_VERSION}-${RELEASE_SOURCE_COMMIT} \
    BUILD_COMPATIBILITY_FAMILY=snus-runtime-v1 \
    BUILD_ROUTE_CAPABILITIES=ordersRead:v2,ordersRead:v3,ordersRead:v4,orderDetail:v1,orderDetail:v2,orderRecreate:v1,orderRecreate:v2,checkoutWrite:v1,paymentWrite:v1,dashboardRead:v1,dashboardRead:v2 \
    BUILD_FEE_ROUTE_CAPABILITIES=ordersRead:v5,orderDetail:v3,orderRecreate:v3,csvRead:v5,dashboardRead:v3,paymentFeeWrite:v1 \
    PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED=false \
    RUNTIME_SCHEMA_DDL_ENABLED=false \
    PLATFORM_DEMO_SEED=false
RUN npm ci --include-workspace-root -w packages/application -w packages/contracts -w packages/domain -w plugins/accounting -w apps/telegram --no-audit --no-fund && \
    npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY tsconfig.base.json tsconfig.json medusa-config.ts ./
COPY src/ src/
COPY apps/telegram/ apps/telegram/
COPY packages/application/ packages/application/
COPY packages/contracts/ packages/contracts/
COPY packages/domain/ packages/domain/
COPY plugins/ plugins/
COPY db/ db/
COPY scripts/ scripts/
# Medusa creates module migration directories even when a migration is a no-op.
# Allow the runtime group to write to those directories only.
RUN chown -R node:node /app && \
    for module in auth-emailpass fulfillment-manual notification-local cache-inmemory event-bus-local locking file file-local; do \
      directory="/app/node_modules/@medusajs/${module}/dist/migrations"; \
      mkdir -p "$directory" && chown node:20 "$directory" && chmod 2770 "$directory" || exit 1; \
    done
USER node
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O- http://127.0.0.1:9000/health || exit 1
CMD ["/app/scripts/start-medusa.sh", "--host", "0.0.0.0", "--port", "9000"]

FROM medusa AS partner-runtime
ENTRYPOINT ["/app/node_modules/.bin/tsx", "scripts/partner-production-entrypoint.ts"]

FROM manifests AS ai
ARG RELEASE_SOURCE_COMMIT=unknown
ARG RELEASE_PRODUCT_VERSION=2.3.0
LABEL org.opencontainers.image.revision="${RELEASE_SOURCE_COMMIT}" \
      org.opencontainers.image.version="${RELEASE_PRODUCT_VERSION}"
ENV PLATFORM_RUNTIME_SCHEMA_BOOTSTRAP_ENABLED=false \
    RUNTIME_SCHEMA_DDL_ENABLED=false \
    PLATFORM_DEMO_SEED=false
RUN npm ci -w apps/ai --no-audit --no-fund && \
    npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=node:node packages/contracts/ packages/contracts/
COPY --chown=node:node packages/domain/ packages/domain/
COPY --chown=node:node packages/application/ packages/application/
COPY --chown=node:node apps/ai/ ./
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O- http://127.0.0.1:3002/health || exit 1
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]

FROM ai AS exact-outbox-worker
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O- http://127.0.0.1:3003/ready || exit 1
CMD ["/app/node_modules/.bin/tsx", "src/exact-outbox-worker-entrypoint.ts"]

FROM manifests AS telegram
ARG RELEASE_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision="${RELEASE_SOURCE_COMMIT}"
RUN npm ci -w apps/telegram --no-audit --no-fund && \
    npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=node:node apps/telegram/ ./
USER node
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]

FROM quay.io/keycloak/keycloak:26.7.4@sha256:82a77884f3af238beab1e7afd63b5f530e1b5c0590bd7aa60b40a40463e29b2c AS partner-as-upstream
# Keycloak omits desktop RPM dependencies; preserve that minimal inventory.
# Download with DNF, then upgrade only four signed RPMs in the copied rootfs.
# Lend the builder's p11-kit library only while extracting the updated CA stores.
FROM registry.access.redhat.com/ubi9/ubi:9.8@sha256:16e9e43d99e181463513cc84a514859b1abb9460f1c4d9e208da4b4e51cd5cc3 AS partner-as-os-repair
COPY --from=partner-as-upstream / /mnt/rootfs/
RUN rpm --root /mnt/rootfs --import /etc/pki/rpm-gpg/RPM-GPG-KEY-redhat-release && \
    rpm --root /mnt/rootfs -qa --qf '%{NAME} %{VERSION}-%{RELEASE}.%{ARCH}\n' | sort | sed '/^pcre2 /d; /^pcre2-syntax /d; /^ca-certificates /d; /^java-21-openjdk-headless /d' > /tmp/before && \
    dnf --installroot /mnt/rootfs --releasever 9 --setopt=reposdir=/etc/yum.repos.d --setopt=install_weak_deps=false --downloadonly --downloaddir=/tmp/as-rpms --nodocs -y install pcre2-10.40-7.el9_8 pcre2-syntax-10.40-7.el9_8 ca-certificates-2026.2.92_v9.0.319-90.3.el9_8 java-21-openjdk-headless-21.0.13.0.9-1.2.el9 && \
    rpm --root /mnt/rootfs --checksig /tmp/as-rpms/pcre2-10.40-7.el9_8.x86_64.rpm /tmp/as-rpms/pcre2-syntax-10.40-7.el9_8.noarch.rpm /tmp/as-rpms/ca-certificates-2026.2.92_v9.0.319-90.3.el9_8.noarch.rpm /tmp/as-rpms/java-21-openjdk-headless-21.0.13.0.9-1.2.el9.x86_64.rpm && \
    test ! -e /mnt/rootfs/usr/lib64/libp11-kit.so.0 && test ! -L /mnt/rootfs/usr/lib64/libp11-kit.so.0 && \
    cp -L /usr/lib64/libp11-kit.so.0 /mnt/rootfs/usr/lib64/libp11-kit.so.0 && \
    rpm --root /mnt/rootfs -U --nodeps --nodocs /tmp/as-rpms/pcre2-10.40-7.el9_8.x86_64.rpm /tmp/as-rpms/pcre2-syntax-10.40-7.el9_8.noarch.rpm /tmp/as-rpms/ca-certificates-2026.2.92_v9.0.319-90.3.el9_8.noarch.rpm /tmp/as-rpms/java-21-openjdk-headless-21.0.13.0.9-1.2.el9.x86_64.rpm && \
    chroot /mnt/rootfs /usr/bin/update-ca-trust extract && \
    rm /mnt/rootfs/usr/lib64/libp11-kit.so.0 && \
    chroot /mnt/rootfs /usr/bin/env LD_LIBRARY_PATH=/usr/lib/jvm/jre-21/lib:/usr/lib/jvm/jre-21/lib/server /usr/bin/keytool -list -keystore /etc/pki/java/cacerts -storepass changeit > /tmp/java-trust && \
    grep -q '^digicertglobalrootg2,' /tmp/java-trust && \
    ! grep -i -E 'emsigneccrootca-g3|aaacertificateservices' /tmp/java-trust && \
    chroot /mnt/rootfs /usr/bin/grep -qi 'DigiCert Global Root G2' /etc/pki/tls/certs/ca-bundle.crt && \
    ! chroot /mnt/rootfs /usr/bin/grep -i -E 'emSign ECC Root CA - G3|AAA Certificate Services' /etc/pki/tls/certs/ca-bundle.crt && \
    rpm --root /mnt/rootfs -qa --qf '%{NAME} %{VERSION}-%{RELEASE}.%{ARCH}\n' | sort | sed '/^pcre2 /d; /^pcre2-syntax /d; /^ca-certificates /d; /^java-21-openjdk-headless /d' > /tmp/after && \
    test -s /tmp/before && test "$(cat /tmp/before)" = "$(cat /tmp/after)" && \
    test "$(rpm --root /mnt/rootfs -q --qf '%{VERSION}-%{RELEASE}' pcre2)" = '10.40-7.el9_8' && \
    test "$(rpm --root /mnt/rootfs -q --qf '%{VERSION}-%{RELEASE}' pcre2-syntax)" = '10.40-7.el9_8' && \
    test "$(rpm --root /mnt/rootfs -q --qf '%{VERSION}-%{RELEASE}' ca-certificates)" = '2026.2.92_v9.0.319-90.3.el9_8' && \
    test "$(rpm --root /mnt/rootfs -q --qf '%{VERSION}-%{RELEASE}' java-21-openjdk-headless)" = '21.0.13.0.9-1.2.el9' && \
    dnf --installroot /mnt/rootfs --releasever 9 clean all && \
    test ! -e /mnt/rootfs/usr/bin/dnf && test ! -e /mnt/rootfs/usr/bin/rpm
# Replace the pinned dependency families before
# Quarkus augmentation. Node and download tooling never enter the runtime image.
FROM node:20-alpine AS partner-as-dependencies
COPY --from=partner-as-upstream /opt/keycloak/ /opt/keycloak/
COPY docker/partner-as-dependencies.lock.json /tmp/partner-as-dependencies.lock.json
COPY scripts/repair-partner-as-dependencies.mjs /tmp/repair-partner-as-dependencies.mjs
RUN node /tmp/repair-partner-as-dependencies.mjs /opt/keycloak /tmp/partner-as-dependencies.lock.json

FROM partner-as-upstream AS partner-as
COPY --from=partner-as-os-repair /mnt/rootfs/ /
COPY --from=partner-as-dependencies --chown=1000:0 /opt/keycloak/ /opt/keycloak/
ARG RELEASE_SOURCE_COMMIT=unknown
ARG RELEASE_PRODUCT_VERSION=2.3.0
LABEL org.opencontainers.image.revision="${RELEASE_SOURCE_COMMIT}" \
      org.opencontainers.image.version="${RELEASE_PRODUCT_VERSION}"
# Runtime administration uses the HTTPS API; omit the unused vulnerable shaded CLI.
RUN rm -f /opt/keycloak/bin/client/keycloak-admin-cli-26.7.4.jar /opt/keycloak/bin/kcadm.sh /opt/keycloak/bin/kcreg.sh && \
    /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true --metrics-enabled=true
CMD ["start", "--optimized"]

FROM medusa AS server
