# Imagen oficial de Playwright con todos los navegadores
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

# Carpeta de trabajo
WORKDIR /app

# Copiamos package.json y package-lock.json si lo tienes
COPY package*.json ./

# Instalamos dependencias
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . .

# Exponemos el puerto que Render asigna (PORT)
EXPOSE 3000

# Comando de arranque
CMD ["node", "server.js"]
