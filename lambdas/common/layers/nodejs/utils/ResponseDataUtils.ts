import { ResponseBody, ResponseData } from "../interfaces/RequestResponse";

export function CreateResponseData<T>(
    data : T, 
    status : number, 
    headers? : Record<string, string | number | boolean>, 
    cookies? : string[]) : ResponseData<T> {
    return {
        data,
        status,
        headers,
        cookies,
    }
}

export function CreateResponseDataFromBody<T>(
    body : ResponseBody<T>,  
    headers? : Record<string, string | number | boolean>, 
    cookies? : string[]) : ResponseData<ResponseBody<T>> {
    return CreateResponseData(body, body.status, headers, cookies)
}

export function UpdateResponseData<T>(
    data : ResponseData<T>,  
    headers? : Record<string, string | number | boolean>, 
    cookies? : string[]) : ResponseData<T> {
    return { 
        ...data, 
        ...((data.headers || headers) && { headers : { ...(data.headers ?? {}), ...(headers ?? {}) } }),
        ...((data.cookies || cookies) && { cookies : [ ...(data.cookies ?? []), ...(cookies ?? []) ] }),
    }
}