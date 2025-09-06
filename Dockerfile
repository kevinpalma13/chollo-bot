FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Copia manifest e instala dependencias
COPY package*.json ./
RUN npm install --omit=dev

# Copia el resto del proyecto
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
