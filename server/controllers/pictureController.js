import axios from "axios";


const NASA_API_KEY = process.env.NASA_API_KEY;

export const apod = async (req, res) => {
    try {
        const { count, date, start_date, end_date } = req.body;
        
        let url = `https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY`;

        if (count) {
            url += `&count=${count}`;
        }
        if (date) {
            url += `&date=${date}`;
        }
        if(start_date && end_date) {
            url += `&start_date=${start_date}&end_date=${end_date}`;
        }
        
        const response = await axios.get(url);

        res.status(200).json(response.data);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};