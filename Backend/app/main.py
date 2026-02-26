from fastapi import FastAPI, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text
from .db import get_db

app = FastAPI(title="Tibbou")

@app.get("/")
def root():
    return {"name": "Tibbou", "status": "running"}

@app.get("/health")
def health():
    return {"status" : "ok"}

@app.get("/db/ping")
def db_ping(db: Session = Depends(get_db)):
    db.execute(text("select 1"))
    return {"db": "ok"}