// Contexte de la requête en cours (compte, IP), propagé automatiquement à travers les `await`
// grâce à AsyncLocalStorage : le journal sait QUI a déclenché une action sans que chaque
// service ait à transmettre l'utilisateur.
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
