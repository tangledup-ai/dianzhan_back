import client from "./client";

export interface AuthUser {
  id: number;
  name: string;
  role: string;
  shareholderId: number | null;
  shareholderName?: string | null;
  landlordIds: number[];
  phone?: string | null;
}

export const login = (name: string, password: string) =>
  client.post("/auth/login", { name, password }).then(r => r.data);

export const getMe = () =>
  client.get("/auth/me").then(r => r.data);

export const bootstrap = (name: string, password: string) =>
  client.post("/auth/bootstrap", { name, password }).then(r => r.data);
