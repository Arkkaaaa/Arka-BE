declare global {
  namespace Express {
    interface Request {
      requestId: string;
      authContext?: {
        userId: string;
        email: string;
        name: string;
        image: string | null;
        institutionId: string;
        institutionName: string;
        sessionId: string;
        sessionExpiresAt: Date;
      };
    }
  }
}

export {};
