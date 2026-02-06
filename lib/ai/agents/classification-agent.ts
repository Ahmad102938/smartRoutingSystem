import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

// Classification schema
const ClassificationSchema = z.object({
  category: z.enum(['Facilities', 'IT', 'Equipment', 'General']),
  subcategory: z.string(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string()
});

type Classification = z.infer<typeof ClassificationSchema>;

export class ClassificationAgent {
  private model: GoogleGenerativeAI | null = null;
  private genModel: any = null;
  private useMock: boolean = false;

  //every time this agent get called this will run and init the googlegenerativeAi 
  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey.trim() !== '') {
      try {
        this.model = new GoogleGenerativeAI(apiKey);
        this.genModel = this.model.getGenerativeModel({ model: 'gemini-1.5-flash' });
        this.useMock = false;
      } catch (error) {
        console.warn('Failed to initialize Gemini AI, falling back to mock classification:', error);
        this.useMock = true;
      }
    } else {
      console.warn('No Gemini API key provided, using mock classification');
      this.useMock = true;
    }
  }

  //mock data in case agents does not working
  private mockClassify(description: string): Classification {
    const lowerDesc = description.toLowerCase();
    
    // Simple keyword-based classification
    if (lowerDesc.includes('freezer') || lowerDesc.includes('refrigerator') || lowerDesc.includes('cooling')) {
      return {
        category: 'Facilities',
        subcategory: 'Cold Storage',
        priority: 'HIGH',
        confidence: 0.85,
        reasoning: 'Freezer/refrigeration issues pose product spoilage risk'
      };
    }
    
    if (lowerDesc.includes('electrical') || lowerDesc.includes('light') || lowerDesc.includes('power')) {
      return {
        category: 'Facilities',
        subcategory: 'Electrical',
        priority: 'MEDIUM',
        confidence: 0.80,
        reasoning: 'Electrical issues may affect store operations'
      };
    }
    
    if (lowerDesc.includes('pos') || lowerDesc.includes('checkout') || lowerDesc.includes('terminal')) {
      return {
        category: 'IT',
        subcategory: 'POS Systems',
        priority: 'HIGH',
        confidence: 0.90,
        reasoning: 'POS system issues directly impact customer transactions'
      };
    }
    
    if (lowerDesc.includes('network') || lowerDesc.includes('wifi') || lowerDesc.includes('internet')) {
      return {
        category: 'IT',
        subcategory: 'Network',
        priority: 'MEDIUM',
        confidence: 0.75,
        reasoning: 'Network issues affect multiple systems'
      };
    }
    
    if (lowerDesc.includes('cart') || lowerDesc.includes('shelf') || lowerDesc.includes('equipment')) {
      return {
        category: 'Equipment',
        subcategory: 'General Equipment',
        priority: 'LOW',
        confidence: 0.70,
        reasoning: 'General equipment maintenance issue'
      };
    }
    
    // Default classification
    return {
      category: 'General',
      subcategory: 'Maintenance',
      priority: 'MEDIUM',
      confidence: 0.60,
      reasoning: 'General maintenance issue requiring assessment'
    };
  }

  async classify(description: string): Promise<Classification> {
    try {
      if (this.useMock || !this.genModel) {
        console.log('Using mock classification');
        return this.mockClassify(description);
      }

      const prompt = `
You are an expert maintenance issue classifier for Walmart stores. Analyze the following issue description and classify it according to these categories:

CATEGORIES & SUBCATEGORIES:
1. Facilities:
   - Cold Storage (freezers, refrigeration, cooling systems)
   - Electrical (lighting, power outlets, electrical systems)
   - Plumbing (leaks, water systems, drains)
   - HVAC (heating, air conditioning, ventilation)
   - Structural (doors, windows, flooring, walls)

2. IT:
   - POS Systems (point of sale terminals, checkout systems)
   - Network (wifi, internet, connectivity)
   - Computers (workstations, monitors, peripherals)
   - Software (applications, system errors)

3. Equipment:
   - Shopping Carts (cart issues, wheels, baskets)
   - Shelving (display racks, storage systems)
   - Security (cameras, alarms, access control)
   - Cleaning (floor cleaners, maintenance equipment)

4. General:
   - Maintenance (general repairs, miscellaneous)
   - Safety (hazards, emergency equipment)

PRIORITY RULES:
- HIGH: Safety hazards, product spoilage risk, complete system failures, customer-facing critical issues
- MEDIUM: Partial functionality loss, operational impact, non-critical system issues
- LOW: Cosmetic issues, minor inconveniences, scheduled maintenance

Issue Description: "${description}"

Please respond with a JSON object in this exact format:
{
  "category": "Facilities|IT|Equipment|General",
  "subcategory": "specific subcategory name",
  "priority": "HIGH|MEDIUM|LOW",
  "confidence": 0.95,
  "reasoning": "explanation for the classification and priority"
}

Provide your classification with reasoning for the priority level assigned.
      `;

      const result = await this.genModel.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      
      const jsonStr = jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      
      // Validate with Zod schema
      const classification = ClassificationSchema.parse(parsed);
      
      return classification;
    } catch (error) {
      console.error('Classification error, falling back to mock:', error);
      
      // Fallback to mock classification
      return this.mockClassify(description);
    }
  }
}

// Singleton instance
export const classificationAgent = new ClassificationAgent();