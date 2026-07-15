declare module 'zod' {
  export type ZodType<T = unknown> = {
    safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } };
  };

  export interface ZodIssue {
    path: Array<string | number>;
    message: string;
  }

  export const z: any;
}
