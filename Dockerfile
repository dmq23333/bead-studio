FROM python:3.12-slim
WORKDIR /app
COPY server.py ai_grid.py ./
COPY dist ./dist
EXPOSE 8080
CMD ["python", "server.py"]
