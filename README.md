Tibbou: Data Lineage and Cost Management

**Welcome to Tibbou** 

Tibbou is a data lineage and cost management application designed to help organizations understand, monitor, and manage their data infrastructure.

The project provides users with information about data sources, data relationships, lineage, and associated costs. By bringing this information together in one application, Tibbou helps users better understand how data moves through their systems and where resources and costs are being generated.

The goal of Tibbou is to make complex data infrastructure information easier to understand for both technical and non-technical users.

**Key Features**
- Data lineage visualization and management
- Data source and metadata management
- Cost management and analysis
- Backend APIs for retrieving and processing data
- Database integration for storing application information
- User-friendly frontend interface
- Data processing and transformation using dbt
- Integration with Snowflake data
- API-based communication between application components

**Tools and Technologies used**

FastAPI, Supabase, CodeRabbit, React, AWS Amplify

**Installation Instruction**
For development or local setup, the following tools may be required depending on the project components:

- Base44 account/access to the Tibbou project
- Git
- Visual Studio Code
- Python 3.x
- Required database and API access

Access to required environment variables and credentials
Getting the Project

If you need to work with the source code, clone the Tibbou GitHub repository:

git clone [TIBBOU-GITHUB-REPOSITORY-URL]

- Navigate to the project directory

cd tibbou
Base44 Setup

Tibbou uses Base44 to build, configure, and run the application.

- Sign in to Base44 and open the Tibbou project.
- Ensure the required project files and configurations are available.
- Configure any required environment variables or integrations.
- Verify that the application's database, API connections, and other required services are properly configured.
- Use Base44's application preview or deployment functionality to run the application.

**How to run the application**
If local development is required, clone the GitHub repository and install the dependencies specified by the project.

For the Python backend, create and activate a virtual environment:

python -m venv venv

On Windows:

venv\Scripts\activate

Install the required dependencies:

pip install -r requirements.txt

Start the development server with:

uvicorn main:app --reload

The API will normally be available at:

http://127.0.0.1:8000

FastAPI's interactive API documentation can be accessed at:

http://127.0.0.1:8000/docs


**Testing**
Testing was performed to verify that the major components of Tibbou function correctly.

**Backend/API Testing**
The following areas should be tested:

- API starts successfully
- API endpoints respond correctly
- Valid requests return the expected data
- Invalid requests return appropriate errors
- Database connections work correctly
- Required environment variables are configured
- Frontend can communicate with the backend

**Database Testing**
Database functionality should be tested by verifying:

- Database connection
- Data insertion
- Data retrieval
- Data updates
- Data relationships
- Correct handling of missing or invalid data

**Frontend Testing**
The frontend should be tested to verify:

- Pages load correctly
- Navigation works
- Data is displayed correctly
- API data is retrieved successfully
- User interactions work as expected
- Error messages are displayed appropriately
- Interface works across different screen sizes

**Team Contributions**
Tibbou was developed as a capstone project through collaborative work across data engineering, backend development, frontend development, documentation, and project management.