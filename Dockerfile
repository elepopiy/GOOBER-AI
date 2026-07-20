# Node.js resmi imajını kullan
FROM node:20-slim

# Çalışma dizinini ayarla
WORKDIR /app

# Paket dosyalarını kopyala ve bağımlılıkları yükle
COPY package*.json ./
RUN npm install

# Projenin geri kalan dosyalarını kopyala
COPY . .

# Botu veya uygulamayı başlatacak komut (kendi start komutuna göre düzenleyebilirsin)
CMD ["node", "server.js"]