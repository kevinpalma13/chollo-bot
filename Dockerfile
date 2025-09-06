# Usa la imagen oficial de Playwright con todas las dependencias y navegadores
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

# Crea carpeta de app
WORKDIR /app

# Copia manifest y instala deps en modo reproducible
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el resto del proyecto
COPY . .

# Expone el puerto (Render usará la env PORT)
EXPOSE 3000

# Arranca tu servidor
CMD ["node", "server.js"]
