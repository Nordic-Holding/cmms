const API_URL = 'https://atlas.nordicbh.com/api/';

export const googleMapsConfig = {
  apiKey: process.env.GOOGLE_KEY
};

export const IS_LOCALHOST = false;

export const getApiUrl = async (): Promise<string> => API_URL;
