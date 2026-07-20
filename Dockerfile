# =========================================================================
#  G.O.O.B.E.R PRO ENGINE — Production Dockerfile
# =========================================================================

FROM node:20-slim

# mineflayer'ın bazı bağımlılıkları (prismarine-*, node-gyp gerektiren
# opsiyonel native paketler) derleme araçları ister; bunlar olmadan
# npm install ortasında sessizce/gürültülü şekilde patlayabilir.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Önce sadece paket dosyalarını kopyala (Docker layer cache'i verimli kullan)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Projenin geri kalanını kopyala
COPY . .

# Kalıcı veri (kullanıcılar, bot konfigleri) için klasör — volume ile bağlanabilir
RUN mkdir -p /app/data

# Root olmayan kullanıcıyla çalıştır (güvenlik için önemli)
RUN groupadd -r goober && useradd -r -g goober goober \
    && chown -R goober:goober /app
USER goober

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Sunucu gerçekten ayakta mı diye basit sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "server.js"]